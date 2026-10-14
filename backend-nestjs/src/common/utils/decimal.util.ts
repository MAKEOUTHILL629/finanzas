import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';

/** Cualquier valor que pueda convertirse a Decimal sin pasar por aritmética de `number`. */
export type DecimalInput = Decimal | Prisma.Decimal | string | number | bigint | null | undefined;

/**
 * Convierte a `Decimal` (decimal.js) usando SIEMPRE la representación textual. Un `number` solo debe llegar
 * aquí como literal de entrada (JSON del request); nunca como resultado de aritmética flotante.
 */
export function toDecimal(value: DecimalInput, fallback: DecimalInput = 0): Decimal {
  if (value === null || value === undefined || value === '') {
    return fallback === null || fallback === undefined || fallback === '' ? new Decimal(0) : toDecimal(fallback, 0);
  }
  // Decimal (decimal.js) y Prisma.Decimal son objetos: se copian vía su representación textual exacta.
  if (typeof value === 'object') return new Decimal(value.toString());
  return new Decimal(typeof value === 'number' ? String(value) : value.toString());
}

/** Intenta convertir; devuelve null si no es un decimal válido (CSV, input de usuario). */
export function tryToDecimal(value: string): Decimal | null {
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Evita "-0.00" (decimal.js conserva el signo del cero). */
export function normalizeZero(value: Decimal): Decimal {
  return value.isZero() ? new Decimal(0) : value;
}

/** Montos en moneda → 2 decimales (HALF_UP). */
export function money(value: Decimal): Decimal {
  return normalizeZero(value.toDecimalPlaces(2));
}

/** Tasas / TRM → 4 decimales (HALF_UP). */
export function rate(value: Decimal): Decimal {
  return normalizeZero(value.toDecimalPlaces(4));
}

/** Decimal de decimal.js → Prisma.Decimal para escribir en columnas `numeric`. */
export function toDb(value: Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

export function toDbMoney(value: Decimal): Prisma.Decimal {
  return toDb(money(value));
}

export function toDbRate(value: Decimal): Prisma.Decimal {
  return toDb(rate(value));
}

/** Suma exacta de una lista de decimales. */
export function sumDecimals(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
}
