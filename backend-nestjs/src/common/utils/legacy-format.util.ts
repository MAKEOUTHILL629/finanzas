import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { truncateToDay } from './date.util';

/**
 * Formatos de serialización idénticos a los del backend Play (Regla 6: paridad con Angular).
 *  - `java.util.Date` con `Json.writes` por defecto → epoch en milisegundos (number).
 *  - Tarjeta → "yyyy-MM-dd'T'HH:mm:ss".
 *  - /api/pagos/*  → "MM/dd/yyyy".
 */

type DecimalLike = Decimal | Prisma.Decimal | null | undefined;

/** Fecha (`@db.Date` ya es 00:00 UTC) → epoch millis. */
export function dateToMillis(date: Date | null | undefined): number | null {
  return date ? date.getTime() : null;
}

/** Timestamp (`created_at`) → millis del día calendario, igual que `ResultSet.getDate` en Scala. */
export function timestampToDayMillis(date: Date | null | undefined): number | null {
  return date ? truncateToDay(date).getTime() : null;
}

export function formatMdy(date: Date | null | undefined): string | null {
  if (!date) return null;
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${String(date.getUTCFullYear()).padStart(4, '0')}`;
}

/** "yyyy-MM-ddTHH:mm:ss" (sin zona ni milisegundos). */
export function formatLegacyIso(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 19);
}

/** Decimal → number para la frontera JSON (Float legacy). */
export function num(value: DecimalLike): number {
  return value === null || value === undefined ? 0 : new Decimal(value.toString()).toNumber();
}

export function numOrNull(value: DecimalLike): number | null {
  return value === null || value === undefined ? null : new Decimal(value.toString()).toNumber();
}

/** BigInt (int8) → number. */
export function idNum(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
