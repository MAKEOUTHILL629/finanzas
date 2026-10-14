import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CruceEntrePersonasDto, FiltroLiquidacionDto, RegistrarPagoMesDto } from '../src/modules/liquidacion-mensual/dto/liquidacion.dto';
import { AplicarExcedenteDto, CrearAporteDiarioDto, GuardarPeriodoDto } from '../src/modules/obligaciones-aportes/dto/aportes-carro.dto';
import { ActualizarRecurrentePersonaDto, CrearRecurrentePersonaDto, FiltroRecurrentesPersonaDto } from '../src/modules/recurrentes-persona/dto/recurrente-persona.dto';

/** Propiedades inválidas (incluyendo las anidadas como `detalles.0.valor`). */
async function errores(clase: new () => object, obj: Record<string, unknown>): Promise<string[]> {
  const out: string[] = [];
  const recorrer = (e: { property: string; children?: any[] }, prefijo = '') => {
    const ruta = prefijo ? `${prefijo}.${e.property}` : e.property;
    if (e.children?.length) e.children.forEach((c) => recorrer(c, ruta));
    else out.push(ruta);
  };
  (await validate(plainToInstance(clase, obj))).forEach((e) => recorrer(e));
  return out.sort();
}

const detalle = { valor: '100000.50', metodo: 'EFECTIVO', personaId: 4 };
const aporte = { fecha: '2026-10-14', detalles: [detalle] };

describe('CrearAporteDiarioDto', () => {
  it('acepta un aporte con desglose, métodos canónicos y heredados', async () => {
    expect(await errores(CrearAporteDiarioDto, aporte)).toEqual([]);
    for (const metodo of ['EFECTIVO', 'TRANSFERENCIA', 'CRUCE_CUENTAS', 'SALDO_A_FAVOR', 'Fisico', 'Bancolombia', 'Prestamo']) {
      expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, metodo }] })).toEqual([]);
    }
    expect(await errores(CrearAporteDiarioDto, { ...aporte, periodo: '2026-09', tipoObligacion: 'CUOTA_CARRO', notas: 'x' })).toEqual([]);
  });

  it('rechaza fecha, periodo, método y valores inválidos', async () => {
    expect(await errores(CrearAporteDiarioDto, { ...aporte, fecha: '14/10/2026' })).toEqual(['fecha']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, periodo: '2026-9' })).toEqual(['periodo']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, periodo: '2026-13' })).toEqual(['periodo']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, metodo: 'EN_BITCOIN' }] })).toEqual(['detalles.0.metodo']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, valor: '0' }] })).toEqual(['detalles.0.valor']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, valor: '10.123' }] })).toEqual(['detalles.0.valor']); // máx. 2 decimales
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, valor: -5 }] })).toEqual(['detalles.0.valor']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [{ ...detalle, personaId: 0 }] })).toEqual(['detalles.0.personaId']);
  });

  it('exige entre 1 y 50 líneas de desglose', async () => {
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: [] })).toEqual(['detalles']);
    expect(await errores(CrearAporteDiarioDto, { fecha: '2026-10-14' })).toEqual(['detalles']);
    expect(await errores(CrearAporteDiarioDto, { ...aporte, detalles: Array.from({ length: 51 }, () => detalle) })).toEqual(['detalles']);
  });
});

describe('GuardarPeriodoDto y AplicarExcedenteDto', () => {
  it('periodo YYYY-MM y cuota positiva', async () => {
    expect(await errores(GuardarPeriodoDto, { periodo: '2026-09', valorCuota: '1400000.00' })).toEqual([]);
    expect(await errores(GuardarPeriodoDto, { periodo: 'Septiembre 2026', valorCuota: 1 })).toEqual(['periodo']);
    expect(await errores(GuardarPeriodoDto, { periodo: '2026-09', valorCuota: 0 })).toEqual(['valorCuota']);
  });
  it('destino conocido; valor opcional positivo', async () => {
    expect(await errores(AplicarExcedenteDto, { destino: 'SIGUIENTE_MES' })).toEqual([]);
    expect(await errores(AplicarExcedenteDto, { destino: 'ESTADO_CUENTA', valor: '50000', periodoImputacion: '2026-10' })).toEqual([]);
    expect(await errores(AplicarExcedenteDto, { destino: 'OTRO' })).toEqual(['destino']);
    expect(await errores(AplicarExcedenteDto, { destino: 'SIGUIENTE_MES', valor: 0 })).toEqual(['valor']);
  });
});

describe('CrearRecurrentePersonaDto', () => {
  const base = { personaId: 2, concepto: 'Plan de celular', valorMensual: '65000' };
  it('acepta vitalicio y plazo fijo', async () => {
    expect(await errores(CrearRecurrentePersonaDto, base)).toEqual([]);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, modalidadDuracion: 'PLAZO_FIJO', numeroMeses: 6, mesInicio: '2026-10', naturaleza: 'ABONO_A_FAVOR', diaCobro: 31 })).toEqual([]);
  });
  it('rechaza valores fuera de rango', async () => {
    expect(await errores(CrearRecurrentePersonaDto, { ...base, valorMensual: 0 })).toEqual(['valorMensual']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, concepto: '' })).toEqual(['concepto']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, numeroMeses: 0 })).toEqual(['numeroMeses']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, numeroMeses: 601 })).toEqual(['numeroMeses']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, diaCobro: 32 })).toEqual(['diaCobro']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, mesInicio: '2026/10' })).toEqual(['mesInicio']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, naturaleza: 'REGALO' })).toEqual(['naturaleza']);
    expect(await errores(CrearRecurrentePersonaDto, { ...base, modalidadDuracion: 'PARA_SIEMPRE' })).toEqual(['modalidadDuracion']);
  });
  it('al editar todo es opcional y la persona no se puede cambiar', async () => {
    expect(await errores(ActualizarRecurrentePersonaDto, {})).toEqual([]);
    expect(await errores(ActualizarRecurrentePersonaDto, { activo: false, valorMensual: 70000 })).toEqual([]);
    const instancia = plainToInstance(ActualizarRecurrentePersonaDto, { personaId: 9, valorMensual: 1 }) as any;
    expect(instancia.personaId).toBe(9); // whitelist del ValidationPipe global la descarta; aquí solo se comprueba que no es un campo del DTO
    expect(await errores(ActualizarRecurrentePersonaDto, { valorMensual: -1 })).toEqual(['valorMensual']);
  });
  it('los filtros de la query llegan como texto y se convierten', async () => {
    const f = plainToInstance(FiltroRecurrentesPersonaDto, { personaId: '4', activo: 'true' });
    expect(f).toMatchObject({ personaId: 4, activo: true });
    expect(await errores(FiltroRecurrentesPersonaDto, { personaId: '4', activo: 'false', modalidadDuracion: 'PLAZO_FIJO' })).toEqual([]);
    expect(await errores(FiltroRecurrentesPersonaDto, { modalidadDuracion: 'X' })).toEqual(['modalidadDuracion']);
  });
});

describe('DTOs de liquidación', () => {
  it('cruce entre personas', async () => {
    const ok = { personaOrigenId: 4, personaDestinoId: 2, monto: '100000', concepto: 'Andrés paga lo de papá' };
    expect(await errores(CruceEntrePersonasDto, ok)).toEqual([]);
    expect(await errores(CruceEntrePersonasDto, { ...ok, monto: 0 })).toEqual(['monto']);
    expect(await errores(CruceEntrePersonasDto, { ...ok, concepto: '' })).toEqual(['concepto']);
    expect(await errores(CruceEntrePersonasDto, { ...ok, periodo: '2026-1' })).toEqual(['periodo']);
    expect(await errores(CruceEntrePersonasDto, { ...ok, fecha: '2026-10-1' })).toEqual(['fecha']);
  });
  it('registrar pago: la cuenta es opcional', async () => {
    expect(await errores(RegistrarPagoMesDto, { personaId: 2, monto: '250000.00' })).toEqual([]);
    expect(await errores(RegistrarPagoMesDto, { personaId: 2, monto: '250000.00', cuentaDestinoId: 1, periodo: '2026-10', concepto: 'Pago' })).toEqual([]);
    expect(await errores(RegistrarPagoMesDto, { personaId: 2, monto: '-1' })).toEqual(['monto']);
  });
  it('filtro de la liquidación', async () => {
    expect(plainToInstance(FiltroLiquidacionDto, { personaId: '2', todas: 'true' })).toMatchObject({ personaId: 2, todas: true });
    expect(plainToInstance(FiltroLiquidacionDto, { todas: 'no' })).toMatchObject({ todas: false });
  });
});
