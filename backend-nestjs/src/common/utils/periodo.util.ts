import { utcDate } from './date.util';

/**
 * Aritmética de periodos contables `YYYY-MM` (sin zona horaria: son meses de calendario).
 */

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export function parsePeriodo(periodo: string): { anio: number; mes: number } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodo);
  if (!m) throw new Error(`Periodo inválido: ${periodo}`);
  return { anio: Number(m[1]), mes: Number(m[2]) };
}

export function periodoDe(anio: number, mes: number): string {
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}`;
}

/** Suma (o resta) meses a un periodo: `addMesesPeriodo('2026-11', 3)` → `'2027-02'`. */
export function addMesesPeriodo(periodo: string, meses: number): string {
  const { anio, mes } = parsePeriodo(periodo);
  const total = anio * 12 + (mes - 1) + meses;
  const nuevoAnio = Math.floor(total / 12);
  return periodoDe(nuevoAnio, total - nuevoAnio * 12 + 1);
}

/** Meses de `desde` a `hasta` (negativo si `hasta` es anterior): `mesesEntre('2026-10', '2027-01')` → 3. */
export function mesesEntre(desde: string, hasta: string): number {
  const a = parsePeriodo(desde);
  const b = parsePeriodo(hasta);
  return b.anio * 12 + b.mes - (a.anio * 12 + a.mes);
}

/** `'2026-09'` → `'Septiembre 2026'` (etiqueta del periodo en la cabecera de AppSheet). */
export function nombrePeriodo(periodo: string): string {
  const { anio, mes } = parsePeriodo(periodo);
  return `${MESES[mes - 1]} ${anio}`;
}

export function primerDiaPeriodo(periodo: string): Date {
  const { anio, mes } = parsePeriodo(periodo);
  return utcDate(anio, mes - 1, 1);
}

export function ultimoDiaPeriodo(periodo: string): Date {
  const { anio, mes } = parsePeriodo(periodo);
  return utcDate(anio, mes, 0);
}
