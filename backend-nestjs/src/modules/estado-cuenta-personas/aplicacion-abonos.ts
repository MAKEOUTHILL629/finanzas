import { Decimal } from '../../config/decimal.config';
import { money } from '../../common/utils/decimal.util';

export interface CargoAplicable {
  /** Identifica el cargo (el que lo pide lo usa para leer su cobertura). */
  clave: string;
  /** `YYYY-MM` al que se imputa. */
  periodo: string;
  fecha: Date;
  monto: Decimal;
}

export type EstadoCobertura = 'PAGADA' | 'PARCIAL' | 'PENDIENTE';

export interface Cobertura {
  cubierto: Decimal;
  pendiente: Decimal;
  estado: EstadoCobertura;
}

/**
 * Aplica lo que la persona ya pagó a sus cargos del más antiguo al más nuevo (FIFO) para saber CUÁLES quedaron saldados:
 * «con el abono de $300.000 se pagaron las cuotas de agosto y septiembre y la de octubre quedó a medias».
 *
 * Los abonos no se amarran a una cuota concreta en la base de datos (el saldo de una persona es un acumulado), así que esta es
 * la lectura natural y siempre coherente con el saldo: Σ pendiente de los cargos = Σ cargos − Σ abonos (si no hay saldo a favor).
 * Es una función pura: no toca la base de datos.
 */
export function aplicarAbonosFifo(cargos: CargoAplicable[], abonos: Decimal): { coberturas: Map<string, Cobertura>; sobrante: Decimal } {
  const orden = [...cargos].sort((a, b) => a.periodo.localeCompare(b.periodo) || a.fecha.getTime() - b.fecha.getTime() || a.clave.localeCompare(b.clave));
  let disponible = abonos.isNegative() ? new Decimal(0) : abonos;
  const coberturas = new Map<string, Cobertura>();
  for (const c of orden) {
    const aplicado = Decimal.min(disponible, c.monto);
    disponible = disponible.minus(aplicado);
    const cubierto = money(aplicado);
    const pendiente = money(c.monto.minus(aplicado));
    coberturas.set(c.clave, { cubierto, pendiente, estado: pendiente.isZero() ? 'PAGADA' : cubierto.isZero() ? 'PENDIENTE' : 'PARCIAL' });
  }
  return { coberturas, sobrante: money(disponible) };
}
