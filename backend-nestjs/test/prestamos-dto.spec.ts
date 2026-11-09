import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePrestamoDto, UpdatePrestamoDto } from '../src/modules/prestamos/dto/prestamo.dto';

/** Propiedades inválidas del DTO (con las mismas opciones del pipe global: `transform` sin conversión implícita). */
async function errores(clase: new () => object, obj: Record<string, unknown>): Promise<string[]> {
  return (await validate(plainToInstance(clase, obj), { whitelist: true })).map((e) => e.property).sort();
}

/** Para cada valor, qué propiedades salen inválidas: así, si uno falla, el mensaje dice cuál. */
async function porValor(clase: new () => object, base: Record<string, unknown>, campo: string, valores: unknown[]): Promise<Array<[string, string[]]>> {
  return Promise.all(valores.map(async (v): Promise<[string, string[]]> => [String(v), await errores(clase, { ...base, [campo]: v })]));
}

const prestamo = {
  concepto: 'Youtube Premium',
  fechaCobro: '2026-10-31',
  responsable: 2,
  estado: 'Pendiente',
  comentarios: '',
  direccionPrestamo: 'POR_COBRAR',
  fechaPrestamo: '2026-10-01',
};

describe('CreatePrestamoDto · importes', () => {
  it('valorPrestado acepta número o texto decimal (el front lo manda como texto para no perder precisión)', async () => {
    const validos = [30000, 30000.5, '30000', '30000.50'];
    expect(await porValor(CreatePrestamoDto, prestamo, 'valorPrestado', validos)).toEqual(validos.map((v) => [String(v), []]));
  });

  it('valorPrestado rechaza lo que no es un importe (con máx. 2 decimales)', async () => {
    const invalidos = ['abc', '', '10.123', '1,5', NaN, null, undefined, -5];
    expect(await porValor(CreatePrestamoDto, prestamo, 'valorPrestado', invalidos)).toEqual(invalidos.map((v) => [String(v), ['valorPrestado']]));
  });

  it('cuotaMensualAcordada es opcional y acepta número o texto', async () => {
    const base = { ...prestamo, valorPrestado: '30000' };
    expect(await errores(CreatePrestamoDto, base)).toEqual([]);
    const validos = [150000, '150000', '150000.50'];
    expect(await porValor(CreatePrestamoDto, base, 'cuotaMensualAcordada', validos)).toEqual(validos.map((v) => [String(v), []]));
    expect(await errores(CreatePrestamoDto, { ...base, cuotaMensualAcordada: 'x' })).toEqual(['cuotaMensualAcordada']);
  });
});

describe('UpdatePrestamoDto · saldoPendiente', () => {
  it('es opcional y acepta número o texto no negativo', async () => {
    expect(await errores(UpdatePrestamoDto, {})).toEqual([]);
    const validos = [0, 25000.5, '0', '25000.50'];
    expect(await porValor(UpdatePrestamoDto, {}, 'saldoPendiente', validos)).toEqual(validos.map((v) => [String(v), []]));
  });

  it('rechaza un saldo negativo o que no es un importe', async () => {
    const invalidos = ['-1', -1, 'abc', '10.123'];
    expect(await porValor(UpdatePrestamoDto, {}, 'saldoPendiente', invalidos)).toEqual(invalidos.map((v) => [String(v), ['saldoPendiente']]));
  });
});
