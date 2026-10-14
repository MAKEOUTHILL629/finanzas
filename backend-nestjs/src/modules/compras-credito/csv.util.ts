import { parse } from 'csv-parse/sync';
import { Decimal } from '../../config/decimal.config';
import { buildValidDate, todayLocal } from '../../common/utils/date.util';
import { tryToDecimal } from '../../common/utils/decimal.util';

/**
 * Utilidades del cargador masivo (`README_CSV_UPLOAD.md`, `ComprasCreditoControlador.uploadCsv`).
 */

export interface ParsedCsv {
  delimiter: ',' | ';';
  headers: string[];
  records: string[][];
}

/** Cuenta ',' vs ';' en la primera línea: gana ';' solo si hay más punto y coma que comas (como el legacy). */
export function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const commas = [...firstLine].filter((c) => c === ',').length;
  const semicolons = [...firstLine].filter((c) => c === ';').length;
  return semicolons > commas ? ';' : ',';
}

/** Primera fila = encabezados; ignora líneas vacías; recorta espacios (CSVFormat.withTrim). */
export function parseCsv(text: string): ParsedCsv {
  const delimiter = detectDelimiter(text);
  const rows = parse(text, {
    delimiter,
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
  const [headers = [], ...records] = rows;
  return { delimiter, headers, records };
}

/** Valor de la primera columna cuyo encabezado (case-insensitive) coincide con alguno de `names`, en orden de prioridad. */
export function getColumnValue(headers: string[], record: string[], names: string[]): string {
  for (const name of names) {
    const index = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (index >= 0) return (record[index] ?? '').trim();
  }
  return '';
}

/** Decimal con punto o coma ("1500000,50" → 1500000.50). `null` si está vacío o es inválido. */
export function parseDecimalCsv(value: string): Decimal | null {
  if (!value) return null;
  return tryToDecimal(value.replace(',', '.'));
}

/** Entero estricto (equivale a `String.toInt` de Scala). */
export function parseIntCsv(value: string): number | null {
  return /^[+-]?\d+$/.test(value) ? Number.parseInt(value, 10) : null;
}

const DATE_FORMATS: Array<{ regex: RegExp; order: 'dmy' | 'ymd' }> = [
  { regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: 'ymd' }, // 2024-04-05
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: 'dmy' }, // 05/04/2024
  { regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: 'dmy' }, // 05-04-2024
  { regex: /^(\d{1,2}),(\d{1,2}),(\d{4})$/, order: 'dmy' }, // 05,04,2024
  { regex: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: 'ymd' }, // 2024/04/05
  { regex: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: 'dmy' }, // 05.04.2024
  { regex: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, order: 'ymd' }, // 2025.04.05 (ejemplo_compras_minusculas.csv)
];

/**
 * Parser estricto de fechas (los formatos del README). Vacía o inválida → fecha actual, igual que el legacy.
 * (El legacy usaba SimpleDateFormat permisivo, que interpretaba "05-04-2024" como año 5; ver MIGRATION_INVENTORY D8.)
 */
export function parseFechaCsv(value: string, hoy: Date = todayLocal()): Date {
  const text = value.trim();
  if (!text) return hoy;
  for (const { regex, order } of DATE_FORMATS) {
    const m = regex.exec(text);
    if (!m) continue;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = order === 'ymd' ? buildValidDate(a, b, c) : buildValidDate(c, b, a);
    if (date) return date;
  }
  return hoy;
}

/** Mayúscula inicial de cada palabra sin tocar el resto (`String.capitalize` de Scala). */
export function capitalizeHeader(header: string): string {
  return header
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function escapeField(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV de respuesta: encabezados capitalizados + "Resultado", mismo delimitador, separador de registro CRLF. */
export function serializeResultCsv(
  headers: string[],
  rows: Array<{ values: string[]; resultado: string }>,
  delimiter: ',' | ';',
): string {
  const lines: string[] = [];
  lines.push([...headers.map(capitalizeHeader), 'Resultado'].map((v) => escapeField(v, delimiter)).join(delimiter));
  for (const { values, resultado } of rows) {
    const padded = headers.map((_, i) => values[i] ?? '');
    lines.push([...padded, resultado].map((v) => escapeField(v, delimiter)).join(delimiter));
  }
  return lines.join('\r\n') + '\r\n';
}
