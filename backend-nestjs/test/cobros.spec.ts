/* eslint-disable @typescript-eslint/no-explicit-any */
import { Decimal } from '../src/config/decimal.config';
import { LimiteTasa } from '../src/common/utils/rate-limit.util';
import { calcularPartes } from '../src/modules/cobros/cobro-division.calc';
import { MAX_COMPROBANTE_BYTES, nombreSeguro, validarComprobante } from '../src/modules/cobros/comprobante.util';
import { GuardarCobroPuntualDto, ReportarPagoDto } from '../src/modules/cobros/dto/cobros.dto';
import { AsignarProductoDto } from '../src/modules/notificaciones-correo/dto/productos-correo.dto';
import { agregarUltimos4, ProductosCorreoService } from '../src/modules/notificaciones-correo/productos-correo.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const d = (v: string | number) => new Decimal(v);
const montos = (partes: ReturnType<typeof calcularPartes>) => partes.map((p) => p.monto.toString());

describe('cobro-division.calc — reparto de un gasto', () => {
  const personas = (...ids: number[]) => ids.map((personaId) => ({ personaId }));

  it('IGUAL: la suma es exactamente el total y los centavos sobrantes van a los primeros', () => {
    expect(montos(calcularPartes(d(100), 'IGUAL', personas(1, 2, 3), null))).toEqual(['33.34', '33.33', '33.33']);
    expect(montos(calcularPartes(d(10), 'IGUAL', personas(1, 2, 3, 4), null))).toEqual(['2.5', '2.5', '2.5', '2.5']);
    expect(montos(calcularPartes(d('0.05'), 'IGUAL', personas(1, 2, 3), null))).toEqual(['0.02', '0.02', '0.01']);
    for (const total of ['184500', '99.99', '1000000.01']) {
      const partes = calcularPartes(d(total), 'IGUAL', personas(1, 2, 3, 4, 5, 6, 7), null);
      expect(partes.reduce((acc, p) => acc.plus(p.monto), d(0)).toString()).toBe(d(total).toString());
    }
  });

  it('marca la parte del propietario (no genera deuda)', () => {
    const partes = calcularPartes(d(90), 'IGUAL', personas(1, 2, 3), 2n);
    expect(partes.map((p) => p.esPropio)).toEqual([false, true, false]);
    expect(calcularPartes(d(90), 'IGUAL', personas(1), null)[0].esPropio).toBe(false);
  });

  it('PORCENTAJE: lo no repartido es del propietario; al repartir el 100 % el último absorbe el redondeo', () => {
    const parcial = calcularPartes(d(200000), 'PORCENTAJE', [{ personaId: 1, porcentaje: 30 }, { personaId: 2, porcentaje: 20 }], null);
    expect(montos(parcial)).toEqual(['60000', '40000']);
    const completo = calcularPartes(d(100), 'PORCENTAJE', [{ personaId: 1, porcentaje: '33.3333' }, { personaId: 2, porcentaje: '33.3333' }, { personaId: 3, porcentaje: '33.3334' }], null);
    expect(completo.reduce((acc, p) => acc.plus(p.monto), d(0)).toString()).toBe('100');
  });

  it('MONTO: montos fijos; el porcentaje implícito queda registrado', () => {
    const partes = calcularPartes(d(500000), 'MONTO', [{ personaId: 1, monto: 150000 }, { personaId: 2, monto: '100000.50' }], null);
    expect(montos(partes)).toEqual(['150000', '100000.5']);
    expect(partes[0].porcentaje?.toString()).toBe('30');
  });

  it.each([
    ['total cero', () => calcularPartes(d(0), 'IGUAL', [{ personaId: 1 }], null)],
    ['sin participantes', () => calcularPartes(d(10), 'IGUAL', [], null)],
    ['persona repetida', () => calcularPartes(d(10), 'IGUAL', [{ personaId: 1 }, { personaId: 1 }], null)],
    ['porcentajes > 100', () => calcularPartes(d(10), 'PORCENTAJE', [{ personaId: 1, porcentaje: 60 }, { personaId: 2, porcentaje: 50 }], null)],
    ['porcentaje ausente', () => calcularPartes(d(10), 'PORCENTAJE', [{ personaId: 1 }], null)],
    ['porcentaje 0', () => calcularPartes(d(10), 'PORCENTAJE', [{ personaId: 1, porcentaje: 0 }], null)],
    ['montos que superan el total', () => calcularPartes(d(10), 'MONTO', [{ personaId: 1, monto: 6 }, { personaId: 2, monto: 5 }], null)],
    ['monto ausente', () => calcularPartes(d(10), 'MONTO', [{ personaId: 1 }], null)],
  ])('rechaza: %s', (_n, fn) => {
    expect(fn).toThrow();
  });
});

describe('comprobante.util — el archivo debe ser lo que dice ser', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString('base64');
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]).toString('base64');
  const PDF = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPG],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
  ])('acepta %s legítimo (también con prefijo data: y saltos de línea)', (tipo, datos) => {
    const r = validarComprobante({ nombre: 'x', tipo, datos });
    expect(r.tipo).toBe(tipo);
    expect(r.tamano).toBe(r.datos.length);
    expect(validarComprobante({ nombre: 'x', tipo, datos: `data:${tipo};base64,${datos.slice(0, 8)}\n${datos.slice(8)}` }).datos.equals(r.datos)).toBe(true);
  });

  it('rechaza tipos no permitidos, contenido que no coincide, base64 inválido, vacío y exceso de tamaño', () => {
    expect(() => validarComprobante({ nombre: 'a', tipo: 'image/gif', datos: PNG })).toThrow();
    expect(() => validarComprobante({ nombre: 'a', tipo: 'text/html', datos: Buffer.from('<script>').toString('base64') })).toThrow();
    expect(() => validarComprobante({ nombre: 'a', tipo: 'image/png', datos: PDF })).toThrow();
    expect(() => validarComprobante({ nombre: 'a', tipo: 'application/pdf', datos: PNG })).toThrow();
    expect(() => validarComprobante({ nombre: 'a', tipo: 'image/png', datos: 'not base64 !!' })).toThrow();
    expect(() => validarComprobante({ nombre: 'a', tipo: 'image/png', datos: '' })).toThrow();
    const grande = Buffer.concat([Buffer.from(PNG, 'base64').subarray(0, 8), Buffer.alloc(MAX_COMPROBANTE_BYTES)]).toString('base64');
    try {
      validarComprobante({ nombre: 'a', tipo: 'image/png', datos: grande });
      fail('debía lanzar');
    } catch (e: any) {
      expect(e.getResponse().errors.comprobante[0]).toMatch(/máximo/);
    }
  });

  it('sanea el nombre: sin rutas ni caracteres peligrosos, con respaldo', () => {
    expect(nombreSeguro('C:\\Users\\yo\\..\\pago final.png', 'image/png')).toBe('pago final.png');
    expect(nombreSeguro('../../etc/passwd', 'image/png')).toBe('passwd');
    expect(nombreSeguro('<script>alert(1)</script>.png', 'image/png')).toBe('script.png');
    expect(nombreSeguro('', 'application/pdf')).toBe('comprobante.pdf');
    expect(nombreSeguro('///', 'image/png')).toBe('comprobante');
    expect(nombreSeguro('a'.repeat(300) + '.png', 'image/png').length).toBeLessThanOrEqual(120);
  });
});

describe('LimiteTasa — ventana deslizante', () => {
  it('permite hasta el máximo por ventana, por clave, y libera al pasar el tiempo', () => {
    const l = new LimiteTasa();
    const t0 = 1_000_000;
    expect([1, 2, 3].map((i) => l.permitir('a', 3, 60_000, t0 + i))).toEqual([true, true, true]);
    expect(l.permitir('a', 3, 60_000, t0 + 10)).toBe(false);
    expect(l.permitir('b', 3, 60_000, t0 + 10)).toBe(true); // otra clave
    expect(l.permitir('a', 3, 60_000, t0 + 60_005)).toBe(true); // ya salieron de la ventana
  });
});

describe('DTOs de cobros y productos', () => {
  const errores = async (cls: any, plano: object) => (await validate(plainToInstance(cls, plano), { whitelist: true })).map((e) => e.property).sort();

  it('cobro puntual: campos obligatorios y formatos', async () => {
    const ok = { concepto: 'Luz', fechaGasto: '2026-10-14', montoTotal: '184500.50', participantes: [{ personaId: 1 }] };
    expect(await errores(GuardarCobroPuntualDto, ok)).toEqual([]);
    expect(await errores(GuardarCobroPuntualDto, { ...ok, fechaGasto: '14/10/2026', montoTotal: -5, categoria: 'X', participantes: [] })).toEqual(['categoria', 'fechaGasto', 'montoTotal', 'participantes']);
    expect(await errores(GuardarCobroPuntualDto, { ...ok, modoDivision: 'AL_AZAR' })).toEqual(['modoDivision']);
    expect(await errores(GuardarCobroPuntualDto, { ...ok, participantes: [{ personaId: 0 }] })).toEqual(['participantes']);
  });

  it('reporte de pago: monto, fecha, medio y comprobante', async () => {
    const ok = { monto: 250000, fechaPago: '2026-10-30', medio: 'BREB', comprobante: { nombre: 'a.png', tipo: 'image/png', datos: 'AAAA' } };
    expect(await errores(ReportarPagoDto, ok)).toEqual([]);
    expect(await errores(ReportarPagoDto, { ...ok, monto: 0, fechaPago: 'ayer', medio: 'TARJETA' })).toEqual(['fechaPago', 'medio', 'monto']);
    expect(await errores(ReportarPagoDto, { ...ok, comprobante: { nombre: 'a.gif', tipo: 'image/gif', datos: 'AAAA' } })).toEqual(['comprobante']);
  });

  it('asignar producto: exactamente 4 dígitos y destino válido', async () => {
    expect(await errores(AsignarProductoDto, { ultimos4: '1927', destino: 'TARJETA', id: 1 })).toEqual([]);
    expect(await errores(AsignarProductoDto, { ultimos4: '192', destino: 'OTRO' })).toEqual(['destino', 'ultimos4']);
    expect(await errores(AsignarProductoDto, { ultimos4: '19277', destino: 'CUENTA' })).toEqual(['ultimos4']);
  });
});

describe('ProductosCorreoService — evidencia y asignación', () => {
  it('agregarUltimos4 no repite y conserva los existentes', () => {
    expect(agregarUltimos4(null, '1927')).toBe('1927');
    expect(agregarUltimos4('1927', '9587')).toBe('1927,9587');
    expect(agregarUltimos4('1927,9587', '1927')).toBe('1927,9587');
    expect(agregarUltimos4('3698 4278', '7992')).toBe('3698,4278,7992');
  });

  function setup(votos: Array<{ u4: string; tarjeta_id: bigint; votos: number }>) {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => (String(strings.join('?')).includes('count(*)::int AS votos') ? votos : []));
    prisma.tarjetas.findMany.mockResolvedValue([
      { id: 1n, franquicia: 'Mastercard', descripcion: null, ultimos_4_digitos: '9491' },
      { id: 2n, franquicia: 'Amex', descripcion: null, ultimos_4_digitos: null },
    ]);
    prisma.cuentasFinancieras.findMany.mockResolvedValue([{ id: 7n, nombre: 'Ahorros', ultimos_4_digitos: '3698', es_principal: true, is_active: true }]);
    prisma.tarjetas.update.mockImplementation(async ({ data }: any) => ({ id: 2n, ...data }));
    return { prisma, service: new ProductosCorreoService(prisma) };
  }

  it('aprende cuando hay ≥3 votos y ≥75 %; no con pocos votos ni con evidencia dividida; ignora lo ya asignado', async () => {
    const { prisma, service } = setup([
      { u4: '1927', tarjeta_id: 2n, votos: 9 }, // claro
      { u4: '1927', tarjeta_id: 1n, votos: 1 },
      { u4: '5052', tarjeta_id: 1n, votos: 2 }, // pocos
      { u4: '7293', tarjeta_id: 1n, votos: 5 }, // dividido 5/9
      { u4: '7293', tarjeta_id: 2n, votos: 4 },
      { u4: '9491', tarjeta_id: 1n, votos: 50 }, // ya es de la Mastercard
      { u4: '3698', tarjeta_id: 1n, votos: 50 }, // ya es una cuenta
    ]);
    const simulado = await service.inferirTarjetas(1n, { aplicar: false });
    expect(simulado).toEqual([{ ultimos4: '1927', tarjetaId: 2, tarjeta: 'Amex', votos: 9, total: 10, aplicado: false }]);
    expect(prisma.tarjetas.update).not.toHaveBeenCalled();

    const aplicado = await service.inferirTarjetas(1n, { aplicar: true });
    expect(aplicado[0].aplicado).toBe(true);
    expect(prisma.tarjetas.update).toHaveBeenCalledWith({ where: { id: 2n }, data: { ultimos_4_digitos: '1927' } });
  });

  it('asignar: conflicto con 409 si los dígitos ya son de otro producto; exige id o nuevo, no ambos', async () => {
    const { service } = setup([]);
    await expect(service.asignar({ ultimos4: '9491', destino: 'TARJETA', id: 2 }, 1n)).rejects.toMatchObject({ status: 409 });
    await expect(service.asignar({ ultimos4: '3698', destino: 'TARJETA', id: 2 }, 1n)).rejects.toMatchObject({ status: 409 });
    await expect(service.asignar({ ultimos4: '1111', destino: 'TARJETA' }, 1n)).rejects.toMatchObject({ status: 400 });
    await expect(service.asignar({ ultimos4: '1111', destino: 'TARJETA', id: 2, nuevo: {} }, 1n)).rejects.toMatchObject({ status: 400 });
    await expect(service.asignar({ ultimos4: '1111', destino: 'TARJETA', id: 99 }, 1n)).rejects.toMatchObject({ status: 404 });
    void dec;
  });
});
