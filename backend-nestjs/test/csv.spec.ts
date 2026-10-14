/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComprasCreditoCsvService } from '../src/modules/compras-credito/compras-credito-csv.service';
import {
  capitalizeHeader,
  detectDelimiter,
  getColumnValue,
  parseCsv,
  parseDecimalCsv,
  parseFechaCsv,
  parseIntCsv,
  serializeResultCsv,
} from '../src/modules/compras-credito/csv.util';
import { formatIsoDate } from '../src/common/utils/date.util';
import { createPrismaMock, utc } from './helpers/prisma-mock';

const RAIZ = join(__dirname, '..', '..'); // CSV de ejemplo del repo Scala (solo lectura)
const leer = (nombre: string) => readFileSync(join(RAIZ, nombre), 'utf8');
const HOY = utc('2025-02-10');

describe('detección de delimitador', () => {
  it('coma por defecto; punto y coma si hay más ; que ,', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('Fecha Compra;Concepto;Valor,1')).toBe(';');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('parseDecimalCsv / parseIntCsv', () => {
  it('acepta punto o coma decimal', () => {
    expect(parseDecimalCsv('1500000,50')?.toString()).toBe('1500000.5');
    expect(parseDecimalCsv('2.5')?.toString()).toBe('2.5');
    expect(parseDecimalCsv('0')?.toString()).toBe('0');
  });

  it('vacío o inválido → null', () => {
    expect(parseDecimalCsv('')).toBeNull();
    expect(parseDecimalCsv('abc')).toBeNull();
    expect(parseDecimalCsv('1.234,50')).toBeNull(); // igual que el legacy ("1.234.50" no es float)
  });

  it('enteros estrictos', () => {
    expect(parseIntCsv('12')).toBe(12);
    expect(parseIntCsv('12.5')).toBeNull();
    expect(parseIntCsv('')).toBeNull();
  });
});

describe('parseFechaCsv — formatos del README', () => {
  const casos: Array<[string, string]> = [
    ['2024-04-05', '2024-04-05'],
    ['05/04/2024', '2024-04-05'],
    ['05-04-2024', '2024-04-05'], // el legacy lo interpretaba como año 5 (bug D8)
    ['05,04,2024', '2024-04-05'],
    ['2024/04/05', '2024-04-05'],
    ['05.04.2024', '2024-04-05'],
    ['2025.04.05', '2025-04-05'],
    ['31,12,2024', '2024-12-31'],
  ];
  it.each(casos)('%s → %s', (entrada, esperado) => {
    expect(formatIsoDate(parseFechaCsv(entrada, HOY))).toBe(esperado);
  });

  it('vacía o inválida → fecha actual', () => {
    expect(formatIsoDate(parseFechaCsv('', HOY))).toBe('2025-02-10');
    expect(formatIsoDate(parseFechaCsv('31/02/2024', HOY))).toBe('2025-02-10');
    expect(formatIsoDate(parseFechaCsv('no es fecha', HOY))).toBe('2025-02-10');
  });
});

describe('parseCsv con los archivos de ejemplo del repo', () => {
  it('ejemplo_compras.csv (coma)', () => {
    const { delimiter, headers, records } = parseCsv(leer('ejemplo_compras.csv'));
    expect(delimiter).toBe(',');
    expect(headers).toEqual(['Fecha Compra', 'Concepto', 'Valor', 'Cuotas', 'Tarjeta', 'Interes', 'descripcion', 'estado']);
    expect(records).toHaveLength(5);
    expect(getColumnValue(headers, records[0], ['Concepto'])).toBe('Computador portátil');
    expect(getColumnValue(headers, records[1], ['Tarjeta', 'Card'])).toBe('Visa');
    expect(getColumnValue(headers, records[2], ['Fecha Compra', 'Fecha'])).toBe('');
  });

  it('ejemplo_compras_europeo.csv (punto y coma + decimales con coma)', () => {
    const { delimiter, headers, records } = parseCsv(leer('ejemplo_compras_europeo.csv'));
    expect(delimiter).toBe(';');
    expect(getColumnValue(headers, records[0], ['Valor'])).toBe('1500000,50');
    expect(getColumnValue(headers, records[0], ['Fecha Compra'])).toBe('15,01,2025');
  });

  it('encabezados en mayúsculas y alias (case-insensitive)', () => {
    const { headers, records } = parseCsv(leer('ejemplo_compras_mayusculas.csv'));
    expect(getColumnValue(headers, records[0], ['Concepto', 'Descripcion'])).toBe('Tablet Samsung');
    expect(getColumnValue(headers, records[0], ['Fecha Compra'])).toBe('31,12,2024');
    expect(getColumnValue(headers, records[0], ['descripcion', 'Descripción'])).toBe('Tablet para diseño');
  });

  it('ignora líneas vacías y recorta espacios', () => {
    const { records } = parseCsv('A,B\n\n 1 , 2 \n\n3,4\n');
    expect(records).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

describe('serializeResultCsv', () => {
  it('capitaliza encabezados, agrega Resultado, conserva delimitador y escapa lo necesario', () => {
    expect(capitalizeHeader('fecha compra')).toBe('Fecha Compra');
    expect(capitalizeHeader('FECHA COMPRA')).toBe('FECHA COMPRA');
    const csv = serializeResultCsv(
      ['concepto', 'valor'],
      [
        { values: ['Mesa; grande', '10'], resultado: 'Éxito: Compra creada con ID 1' },
        { values: ['x'], resultado: 'Error: Valor inválido ""' },
      ],
      ';',
    );
    expect(csv.split('\r\n')).toEqual([
      'Concepto;Valor;Resultado',
      '"Mesa; grande";10;Éxito: Compra creada con ID 1',
      'x;;"Error: Valor inválido """""',
      '',
    ]);
  });
});

describe('ComprasCreditoCsvService.procesar — validaciones y mensajes del legacy', () => {
  function setup() {
    const prisma = createPrismaMock();
    const compras = { save: jest.fn().mockResolvedValue(123) };
    const service = new ComprasCreditoCsvService(prisma as any, compras as any);
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 1n });
    return { prisma, compras, service };
  }

  const cabecera = 'Fecha Compra,Concepto,Valor,Cuotas,Tarjeta,Interes,descripcion,estado';

  it('fila válida → "Éxito: Compra creada con ID n" y llama a save con Decimal-string', async () => {
    const { compras, service } = setup();
    const { csv, exitosos, errores } = await service.procesar(`${cabecera}\n2024-01-15,Laptop,1500000.50,12,1,2.5,Trabajo,\n`, 7n);

    expect(exitosos).toBe(1);
    expect(errores).toBe(0);
    expect(csv).toContain('Resultado');
    expect(csv).toContain('Éxito: Compra creada con ID 123');
    const entrada = compras.save.mock.calls[0][0];
    expect(entrada).toMatchObject({
      concepto: 'Laptop',
      valorCompra: '1500000.5',
      numeroCuotas: 12,
      interes: '2.5',
      estado: 'Pendiente', // estado vacío → default
      descripcion: 'Trabajo',
      tarjeta: 1n,
    });
    expect(formatIsoDate(entrada.fechaCompra)).toBe('2024-01-15');
    expect(compras.save.mock.calls[0][1]).toBe(7n);
  });

  it.each([
    ['2024-01-15,,100,3,1,2,d,', 'Error: Concepto es obligatorio'],
    ['2024-01-15,X,abc,3,1,2,d,', "Error: Valor inválido 'abc'"],
    ['2024-01-15,X,0,3,1,2,d,', 'Error: Valor debe ser mayor a 0'],
    ['2024-01-15,X,100,tres,1,2,d,', "Error: Cuotas inválido 'tres'"],
    ['2024-01-15,X,100,0,1,2,d,', 'Error: Cuotas debe ser mayor a 0'],
    ['2024-01-15,X,100,3,,2,d,', 'Error: Tarjeta es obligatoria'],
    ['2024-01-15,X,100,3,1,,d,', "Error: Interés inválido ''"],
  ])('fila "%s" → %s', async (fila, mensaje) => {
    const { service } = setup();
    const { csv, errores } = await service.procesar(`${cabecera}\n${fila}\n`, 7n);
    expect(errores).toBe(1);
    expect(csv).toContain(mensaje);
  });

  it('tarjeta inexistente → "Error: Tarjeta \'999\' no encontrada" (sin llamar a save)', async () => {
    const { prisma, compras, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(null);
    const { csv } = await service.procesar(`${cabecera}\n,Tele,2000000,18,999,2.8,TV,Pendiente\n`, 7n);
    expect(csv).toContain("Error: Tarjeta '999' no encontrada");
    expect(compras.save).not.toHaveBeenCalled();
  });

  it('busca la tarjeta por id o por franquicia dentro de las del usuario', async () => {
    const { prisma, service } = setup();
    await service.procesar(`${cabecera}\n2024-01-01,A,100,2,Visa,1,d,\n2024-01-01,B,100,2,5,1,d,\n`, 7n);
    const porFranquicia = prisma.tarjetas.findFirst.mock.calls[0][0];
    expect(porFranquicia.where.owner_user_id).toBe(7n);
    expect(porFranquicia.where.OR).toEqual([{ franquicia: { equals: 'Visa', mode: 'insensitive' } }]);
    const porId = prisma.tarjetas.findFirst.mock.calls[1][0];
    expect(porId.where.OR).toEqual([{ id: 5n }, { franquicia: { equals: '5', mode: 'insensitive' } }]);
  });

  it('un error en save se reporta en esa fila y las demás continúan', async () => {
    const { compras, service } = setup();
    compras.save.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(124);
    const { csv, exitosos, errores } = await service.procesar(
      `${cabecera}\n2024-01-01,A,100,2,1,1,d,\n2024-01-01,B,100,2,1,1,d,\n`,
      7n,
    );
    expect(errores).toBe(1);
    expect(exitosos).toBe(1);
    expect(csv).toContain('Error: boom');
    expect(csv).toContain('Éxito: Compra creada con ID 124');
  });

  it('procesa el CSV europeo de ejemplo completo (5 filas, ; y decimales con coma)', async () => {
    const { compras, service } = setup();
    const { csv, exitosos } = await service.procesar(leer('ejemplo_compras_europeo.csv'), 7n);
    expect(exitosos).toBe(5);
    expect(compras.save.mock.calls[0][0].valorCompra).toBe('1500000.5');
    expect(compras.save.mock.calls[0][0].interes).toBe('2.5');
    expect(csv.split('\r\n')[0]).toBe('Fecha Compra;Concepto;Valor;Cuotas;Tarjeta;Interes;Descripcion;Estado;Resultado');
  });
});
