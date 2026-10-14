/**
 * Utilidades de fechas calendario ("LocalDate"). Todas las fechas se representan como `Date` a las 00:00 UTC,
 * que es exactamente lo que Prisma devuelve/acepta para columnas `@db.Date`. Equivalente a java.time.LocalDate.
 */

export function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

export function buildValidDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1) return null;
  const d = utcDate(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/** Parsea estrictamente `YYYY-MM-DD`; devuelve null si el formato o el calendario no son válidos. */
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return buildValidDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Fecha de hoy según la zona horaria del proceso (equivale a LocalDate.now() con ZoneId.systemDefault). */
export function todayLocal(now: Date = new Date()): Date {
  return utcDate(now.getFullYear(), now.getMonth(), now.getDate());
}

export function endOfMonth(date: Date): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

/** Suma meses de calendario (el día se ajusta al último día válido, como LocalDate.plusMonths). */
export function addMonths(date: Date, months: number): Date {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = utcDate(year, month + 1, 0).getUTCDate();
  return utcDate(year, month, Math.min(date.getUTCDate(), lastDay));
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

/** Periodo contable `YYYY-MM`. */
export function periodoOf(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function isValidPeriodo(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Trunca un instante a su día calendario UTC (equivale a ResultSet.getDate sobre un timestamp). */
export function truncateToDay(date: Date): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Periodo actual `YYYY-MM` según la zona horaria del proceso. */
export function periodoActual(now: Date = new Date()): string {
  return periodoOf(todayLocal(now));
}
