import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { lastValueFrom, of } from 'rxjs';
import {
  JsonSerializationInterceptor,
  serializeForJson,
} from '../src/common/interceptors/json-serialization.interceptor';
import {
  dateToMillis,
  formatLegacyIso,
  formatMdy,
  num,
  numOrNull,
  timestampToDayMillis,
} from '../src/common/utils/legacy-format.util';

describe('JsonSerializationInterceptor — Regla 2 (BigInt y Decimal hacia Angular)', () => {
  it('JSON.stringify revienta con BigInt: es el problema que se resuelve', () => {
    expect(() => JSON.stringify({ id: 1n })).toThrow(TypeError);
  });

  it('bigint seguro → number', () => {
    expect(serializeForJson({ id: 42n })).toEqual({ id: 42 });
  });

  it('bigint fuera de Number.MAX_SAFE_INTEGER → string (no pierde precisión)', () => {
    const grande = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(serializeForJson(grande)).toBe(grande.toString());
  });

  it('Prisma.Decimal (numeric) → number', () => {
    expect(serializeForJson(new Prisma.Decimal('1234567.89'))).toBe(1234567.89);
    expect(serializeForJson({ saldo: new Prisma.Decimal('0.10') })).toEqual({ saldo: 0.1 });
  });

  it('decimal.js Decimal → number', () => {
    expect(serializeForJson(new Decimal('4150.1234'))).toBe(4150.1234);
  });

  it('Date → ISO-8601', () => {
    expect(serializeForJson(new Date('2026-10-13T15:30:00.000Z'))).toBe('2026-10-13T15:30:00.000Z');
    expect(serializeForJson(new Date('invalid'))).toBeNull();
  });

  it('recorre recursivamente objetos y arrays anidados', () => {
    const entrada = {
      id: 1n,
      items: [{ monto: new Prisma.Decimal('10.5'), fecha: new Date('2026-01-01T00:00:00Z'), tags: ['a', 2n] }],
      anidado: { a: { b: { c: 99n } } },
      nulo: null,
      indefinido: undefined,
      texto: 'ok',
      booleano: false,
      numero: 3,
    };
    const salida = serializeForJson(entrada) as Record<string, unknown>;
    expect(salida).toEqual({
      id: 1,
      items: [{ monto: 10.5, fecha: '2026-01-01T00:00:00.000Z', tags: ['a', 2] }],
      anidado: { a: { b: { c: 99 } } },
      nulo: null,
      indefinido: undefined,
      texto: 'ok',
      booleano: false,
      numero: 3,
    });
    expect(() => JSON.stringify(salida)).not.toThrow();
  });

  it('respeta strings, Buffers y StreamableFile', () => {
    const buffer = Buffer.from('x');
    const archivo = new StreamableFile(buffer);
    expect(serializeForJson('a,b\n1,2')).toBe('a,b\n1,2');
    expect(serializeForJson(buffer)).toBe(buffer);
    expect(serializeForJson(archivo)).toBe(archivo);
  });

  it('es un interceptor de Nest que transforma la respuesta del handler', async () => {
    const interceptor = new JsonSerializationInterceptor();
    const handler: CallHandler = { handle: () => of({ id: 5n, monto: new Prisma.Decimal('99.99') }) };
    const resultado = await lastValueFrom(interceptor.intercept({} as ExecutionContext, handler));
    expect(resultado).toEqual({ id: 5, monto: 99.99 });
  });
});

describe('formatos de fecha/número del contrato legacy', () => {
  const fecha = new Date('2024-04-05T00:00:00.000Z');

  it('Date de Play = epoch millis', () => {
    expect(dateToMillis(fecha)).toBe(1712275200000);
    expect(dateToMillis(null)).toBeNull();
  });

  it('timestamptz → millis del día calendario (ResultSet.getDate)', () => {
    expect(timestampToDayMillis(new Date('2024-04-05T18:45:10.000Z'))).toBe(1712275200000);
  });

  it('Tarjeta usa yyyy-MM-dd\'T\'HH:mm:ss y los pagos MM/dd/yyyy', () => {
    expect(formatLegacyIso(new Date('2026-03-01T23:39:06.123Z'))).toBe('2026-03-01T23:39:06');
    expect(formatMdy(new Date('2024-04-05T00:00:00Z'))).toBe('04/05/2024');
    expect(formatMdy(null)).toBeNull();
  });

  it('Decimal → number de la frontera JSON', () => {
    expect(num(new Prisma.Decimal('85000.00'))).toBe(85000);
    expect(num(null)).toBe(0);
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(new Prisma.Decimal('1.8895'))).toBe(1.8895);
  });
});
