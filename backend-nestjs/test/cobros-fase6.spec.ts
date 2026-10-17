/* eslint-disable @typescript-eslint/no-explicit-any */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Decimal } from '../src/config/decimal.config';
import { asegurarClaves, buscarItem, claveDeItem, conceptoDeAjuste, descuentoDeResolucion, errorDeNumeroMetodo } from '../src/modules/cobros/ajustes-cobro.util';
import { ActualizarMetodoPagoDto, CrearMetodoPagoDto, DescuentoDirectoDto, ObjetarCobroDto, ResolverObjecionDto } from '../src/modules/cobros/dto/cobros-fase6.dto';
import { categoriaDeMovimiento, origenDeMovimiento } from '../src/modules/liquidacion-mensual/liquidacion-mensual.service';

const d = (v: string | number) => new Decimal(v);
const errores = async (clase: any, datos: object) => (await validate(plainToInstance(clase, datos) as object)).map((e) => e.property);

describe('errorDeNumeroMetodo — el número tiene sentido para cada medio de pago', () => {
  it('cuentas: 6 a 25 dígitos (admite espacios y guiones)', () => {
    expect(errorDeNumeroMetodo('CUENTA_AHORROS', '123-456789-01')).toBeNull();
    expect(errorDeNumeroMetodo('CUENTA_CORRIENTE', '1234 5678 901')).toBeNull();
    expect(errorDeNumeroMetodo('CUENTA_AHORROS', '12345')).toContain('6 y 25 dígitos');
    expect(errorDeNumeroMetodo('CUENTA_AHORROS', 'abc-123-xyz')).toContain('dígitos');
  });

  it('Nequi y Daviplata: celular colombiano de 10 dígitos que empieza por 3 (con o sin +57)', () => {
    expect(errorDeNumeroMetodo('NEQUI', '300 123 4567')).toBeNull();
    expect(errorDeNumeroMetodo('DAVIPLATA', '+57 3101234567')).toBeNull();
    expect(errorDeNumeroMetodo('NEQUI', '1234567890')).toContain('celular');
    expect(errorDeNumeroMetodo('NEQUI', '30012345')).toContain('celular');
  });

  it('llave Bre-B / Transfiya: alias, correo o celular; no admite caracteres raros', () => {
    expect(errorDeNumeroMetodo('LLAVE', '@felipe123')).toBeNull();
    expect(errorDeNumeroMetodo('LLAVE', 'felipe@correo.com')).toBeNull();
    expect(errorDeNumeroMetodo('LLAVE', '3001234567')).toBeNull();
    expect(errorDeNumeroMetodo('LLAVE', 'hola; DROP TABLE')).toContain('llave');
  });

  it('OTRO acepta cualquier texto de 3 o más letras; menos que eso no', () => {
    expect(errorDeNumeroMetodo('OTRO', 'Efectivo en mano')).toBeNull();
    expect(errorDeNumeroMetodo('OTRO', 'ab')).toContain('Escribe');
  });
});

describe('claveDeItem / asegurarClaves / buscarItem — identidad de cada renglón del enlace', () => {
  const item = { fecha: '2026-10-14', concepto: 'Recibo de la luz', impacto: 61500, origen: 'COBRO_PUNTUAL' };

  it('es estable: el mismo renglón da siempre la misma clave (sin importar mayúsculas ni espacios al final)', () => {
    const k = claveDeItem('cobrosPuntuales', item);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(claveDeItem('cobrosPuntuales', { ...item, concepto: '  RECIBO DE LA LUZ ' })).toBe(k);
    expect(claveDeItem('cobrosPuntuales', { ...item, impacto: 61500.0 })).toBe(k);
  });

  it('cambia si cambia el bloque, la fecha, el concepto, el monto o el origen', () => {
    const k = claveDeItem('cobrosPuntuales', item);
    expect(claveDeItem('otros', item)).not.toBe(k);
    expect(claveDeItem('cobrosPuntuales', { ...item, fecha: '2026-10-15' })).not.toBe(k);
    expect(claveDeItem('cobrosPuntuales', { ...item, concepto: 'Mercado' })).not.toBe(k);
    expect(claveDeItem('cobrosPuntuales', { ...item, impacto: 61501 })).not.toBe(k);
    expect(claveDeItem('cobrosPuntuales', { ...item, origen: 'PRESTAMO' })).not.toBe(k);
  });

  it('asegurarClaves completa las fotos antiguas y respeta las claves que ya traen; buscarItem encuentra por clave', () => {
    const snapshot: any = {
      bloques: [
        { clave: 'cobrosPuntuales', items: [{ ...item }, { ...item, concepto: 'Mercado', clave: 'ya-trae-su-clave' }] },
        { clave: 'otros', items: [] },
      ],
    };
    asegurarClaves(snapshot);
    expect(snapshot.bloques[0].items[0].clave).toBe(claveDeItem('cobrosPuntuales', item));
    expect(snapshot.bloques[0].items[1].clave).toBe('ya-trae-su-clave');
    expect(buscarItem(snapshot, claveDeItem('cobrosPuntuales', item))).toEqual({ bloque: 'cobrosPuntuales', clave: claveDeItem('cobrosPuntuales', item), concepto: 'Recibo de la luz', fecha: '2026-10-14', impacto: 61500 });
    expect(buscarItem(snapshot, 'no-existe')).toBeNull();
    // aunque la foto sea anterior a las claves, se puede buscar por la clave calculada
    expect(buscarItem({ bloques: [{ clave: 'cobrosPuntuales', items: [{ ...item }] }] }, claveDeItem('cobrosPuntuales', item))?.concepto).toBe('Recibo de la luz');
  });
});

describe('descuentoDeResolucion — cuánto se le descuenta a la persona', () => {
  const base = { itemMonto: d(61500), saldoPendiente: d(200000) };

  it('MANTENER no toca el saldo', () => {
    expect(descuentoDeResolucion({ accion: 'MANTENER', monto: null, ...base })).toBeNull();
  });

  it('AJUSTAR: el descuento es lo cobrado menos el monto nuevo', () => {
    expect(descuentoDeResolucion({ accion: 'AJUSTAR', monto: 40000, ...base })!.toString()).toBe('21500');
    expect(descuentoDeResolucion({ accion: 'AJUSTAR', monto: '0', ...base })!.toString()).toBe('61500'); // equivale a excluir
    expect(descuentoDeResolucion({ accion: 'AJUSTAR', monto: '40000.505', ...base })!.toString()).toBe('21499.49');
  });

  it('AJUSTAR exige un monto nuevo menor al actual, no negativo y un renglón que sea un cobro', () => {
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: 61500, ...base })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: 70000, ...base })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: -1, ...base })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: null, ...base })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: 10, itemMonto: null, saldoPendiente: d(10) })).toThrow(); // objeción sobre el total
    expect(() => descuentoDeResolucion({ accion: 'AJUSTAR', monto: 10, itemMonto: d(-50000), saldoPendiente: d(10) })).toThrow(); // un abono
  });

  it('EXCLUIR descuenta el renglón completo; solo cobros', () => {
    expect(descuentoDeResolucion({ accion: 'EXCLUIR', ...base })!.toString()).toBe('61500');
    expect(() => descuentoDeResolucion({ accion: 'EXCLUIR', itemMonto: null, saldoPendiente: d(10) })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'EXCLUIR', itemMonto: d(-1), saldoPendiente: d(10) })).toThrow();
  });

  it('DESCUENTO: cualquier monto positivo que no pase de lo que debe', () => {
    expect(descuentoDeResolucion({ accion: 'DESCUENTO', monto: 50000, itemMonto: null, saldoPendiente: d(200000) })!.toString()).toBe('50000');
    expect(descuentoDeResolucion({ accion: 'DESCUENTO', monto: 200000, itemMonto: null, saldoPendiente: d(200000) })!.toString()).toBe('200000');
    expect(() => descuentoDeResolucion({ accion: 'DESCUENTO', monto: 200000.01, itemMonto: null, saldoPendiente: d(200000) })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'DESCUENTO', monto: 0, itemMonto: null, saldoPendiente: d(200000) })).toThrow();
    expect(() => descuentoDeResolucion({ accion: 'DESCUENTO', monto: '', itemMonto: null, saldoPendiente: d(200000) })).toThrow();
  });

  it('el texto del asiento cuenta qué pasó, con el formato de dinero de la app', () => {
    expect(conceptoDeAjuste({ accion: 'AJUSTAR', itemConcepto: 'Recibo de la luz', itemMonto: d(61500), descuento: d(21500) })).toBe('Ajuste de «Recibo de la luz»: de $61,500.00 a $40,000.00');
    expect(conceptoDeAjuste({ accion: 'EXCLUIR', itemConcepto: 'Mercado', itemMonto: d(30000), descuento: d(30000) })).toBe('Cobro excluido: «Mercado»');
    expect(conceptoDeAjuste({ accion: 'DESCUENTO', itemConcepto: null, itemMonto: null, descuento: d(5000), motivo: ' Ya me había abonado ' })).toBe('Descuento del propietario: Ya me había abonado');
    expect(conceptoDeAjuste({ accion: 'DESCUENTO', itemConcepto: null, itemMonto: null, descuento: d(5000), motivo: 'x'.repeat(400) }).length).toBe(255);
  });
});

describe('DTO de la fase 6', () => {
  it('ObjetarCobroDto: el comentario es obligatorio (mínimo 3 letras) y el alcance ITEM o TOTAL', async () => {
    expect(await errores(ObjetarCobroDto, { alcance: 'ITEM', itemClave: 'abc', comentario: 'Ya te abono $50.000' })).toEqual([]);
    expect(await errores(ObjetarCobroDto, { alcance: 'TOTAL', comentario: 'No reconozco el total' })).toEqual([]);
    expect(await errores(ObjetarCobroDto, { alcance: 'ITEM', itemClave: 'abc' })).toContain('comentario');
    expect(await errores(ObjetarCobroDto, { alcance: 'ITEM', itemClave: 'abc', comentario: 'ab' })).toContain('comentario');
    expect(await errores(ObjetarCobroDto, { alcance: 'ITEM', comentario: 'a'.repeat(1001) })).toContain('comentario');
    expect(await errores(ObjetarCobroDto, { alcance: 'OTRO', comentario: 'hola mundo' })).toContain('alcance');
    expect(await errores(ObjetarCobroDto, { alcance: 'TOTAL', comentario: 'hola mundo', montoPropuesto: '-5' })).toContain('montoPropuesto');
    expect(await errores(ObjetarCobroDto, { alcance: 'TOTAL', comentario: 'hola mundo', montoPropuesto: '0' })).toEqual([]); // «no debo nada» es válido
    expect(await errores(ObjetarCobroDto, { alcance: 'TOTAL', comentario: 'hola', montoPropuesto: '' })).toEqual([]); // vacío = no lo dijo
  });

  it('ResolverObjecionDto y DescuentoDirectoDto', async () => {
    expect(await errores(ResolverObjecionDto, { accion: 'MANTENER', respuesta: 'Así quedó' })).toEqual([]);
    expect(await errores(ResolverObjecionDto, { accion: 'AJUSTAR', monto: '40000' })).toEqual([]);
    expect(await errores(ResolverObjecionDto, { accion: 'BORRAR' })).toContain('accion');
    expect(await errores(DescuentoDirectoDto, { monto: '50000', motivo: 'No era suyo' })).toEqual([]);
    expect(await errores(DescuentoDirectoDto, { monto: '0', motivo: 'No era suyo' })).toContain('monto');
    expect(await errores(DescuentoDirectoDto, { monto: '50000', motivo: 'a' })).toContain('motivo');
  });

  it('CrearMetodoPagoDto: tipo válido, entidad y número obligatorios; opcionales vacíos se ignoran', async () => {
    const ok = { tipo: 'NEQUI', entidad: 'Nequi', numero: '3001234567' };
    expect(await errores(CrearMetodoPagoDto, ok)).toEqual([]);
    expect(await errores(CrearMetodoPagoDto, { ...ok, titular: '', documento: '', instrucciones: '', cuentaId: '' })).toEqual([]);
    expect(await errores(CrearMetodoPagoDto, { ...ok, tipo: 'BITCOIN' })).toContain('tipo');
    expect(await errores(CrearMetodoPagoDto, { ...ok, entidad: '' })).toContain('entidad');
    expect(await errores(CrearMetodoPagoDto, { ...ok, numero: 'ab' })).toContain('numero');
    expect(await errores(ActualizarMetodoPagoDto, { activo: false, titular: null })).toEqual([]);
    expect(await errores(ActualizarMetodoPagoDto, { tipo: 'X' })).toContain('tipo');
  });
});

describe('el descuento en la liquidación', () => {
  it('se clasifica como abono con su propio origen («Descuento del propietario»)', () => {
    expect(categoriaDeMovimiento('AJUSTE_DESCUENTO', -1)).toBe('abonosRealizados');
    expect(origenDeMovimiento({ tipo_movimiento: 'AJUSTE_DESCUENTO', cruce_deuda_id: null })).toBe('DESCUENTO');
  });
});
