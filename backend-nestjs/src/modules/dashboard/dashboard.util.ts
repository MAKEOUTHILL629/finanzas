import { addMesesPeriodo, parsePeriodo } from '../../common/utils/periodo.util';
import { utcDate } from '../../common/utils/date.util';

/**
 * ¿Hasta qué día se paga el extracto de un periodo de facturación?
 *
 * Una tarjeta factura en su día de corte y da hasta el «día límite de pago» para pagar. Si el límite es menor o igual que el corte
 * (corte el 15, paga hasta el 5) el pago cae en el mes siguiente; si es mayor (corte el 15, paga hasta el 30) cae en el mismo mes.
 * Sin día de corte se asume el mes siguiente, que es lo habitual. Sin día límite no hay fecha (`null`).
 * El día se ajusta al último del mes (límite 31 en febrero → 28/29).
 */
export function fechaLimiteExtracto(periodo: string, diaCorte: number | null, diaLimite: number | null): Date | null {
  if (!diaLimite || diaLimite < 1 || diaLimite > 31) return null;
  const mesSiguiente = diaCorte === null || diaCorte === undefined ? true : diaLimite <= diaCorte;
  const { anio, mes } = parsePeriodo(mesSiguiente ? addMesesPeriodo(periodo, 1) : periodo);
  const ultimo = utcDate(anio, mes, 0).getUTCDate();
  return utcDate(anio, mes - 1, Math.min(diaLimite, ultimo));
}

export interface ExtractoPendiente {
  periodo: string;
  monto: number;
}

export interface VencimientoExtracto {
  periodo: string;
  fecha: string;
  diasRestantes: number;
  monto: number;
  /** El día límite ya pasó y el extracto sigue sin pagarse. */
  vencido: boolean;
}

const MS_DIA = 86_400_000;

/**
 * Extractos sin pagar de una tarjeta con su fecha límite, del más urgente al más lejano. Los vencidos hace más de `ventanaVencidos`
 * días se omiten (es historia, no una alerta); los que vencen en más de `horizonteDias` días tampoco aparecen.
 */
export function proximosVencimientos(
  hoy: Date,
  extractos: ExtractoPendiente[],
  diaCorte: number | null,
  diaLimite: number | null,
  { horizonteDias = 60, ventanaVencidos = 45 }: { horizonteDias?: number; ventanaVencidos?: number } = {},
): VencimientoExtracto[] {
  const salida: VencimientoExtracto[] = [];
  for (const e of extractos) {
    if (!(e.monto > 0)) continue;
    const fecha = fechaLimiteExtracto(e.periodo, diaCorte, diaLimite);
    if (!fecha) continue;
    const dias = Math.round((fecha.getTime() - hoy.getTime()) / MS_DIA);
    if (dias > horizonteDias || dias < -ventanaVencidos) continue;
    salida.push({ periodo: e.periodo, fecha: fecha.toISOString().slice(0, 10), diasRestantes: dias, monto: e.monto, vencido: dias < 0 });
  }
  return salida.sort((a, b) => a.fecha.localeCompare(b.fecha));
}
