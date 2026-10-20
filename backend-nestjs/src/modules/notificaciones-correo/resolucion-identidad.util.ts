/**
 * Resolución inteligente de IDs en cascada (Fase 1, paso 2). Funciones puras sobre el snapshot:
 *  1) huella determinista / message_id (lo hace el sync por external_message_id),
 *  2) cadena de plásticos (Tarjetas.ultimos_4_digitos con todos los plásticos, sql/008),
 *  3) inferencia por historial del mismo comercio (>80 % en las últimas 10 conciliadas),
 *  4) reconciliación por ventana de ±36 h con monto exacto y comercio similar (≥0.7).
 */
import { Decimal } from '../../config/decimal.config';
import { similitudComercio } from './comercio.util';
import { conceptoNormalizado, SnapshotCorreos } from './snapshot-correos';

export type ConfianzaResolucion = 'EXACTA' | 'CADENA_PLASTICO' | 'ALTA_INFERIDA' | 'VENTANA_36H';

export const VENTANA_36H_MS = 36 * 60 * 60 * 1000;

function dominante(ids: Array<bigint | null | undefined>, max = 10): { id: bigint; frecuencia: number; muestras: number } | null {
  const recientes = ids.filter((x): x is bigint => x !== null && x !== undefined).slice(0, max);
  if (recientes.length === 0) return null;
  const conteo = new Map<bigint, number>();
  for (const id of recientes) conteo.set(id, (conteo.get(id) ?? 0) + 1);
  const [id, n] = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0];
  return { id, frecuencia: n / recientes.length, muestras: recientes.length };
}

/** Paso 3 (tarjeta): tarjeta que el usuario asignó a este comercio en sus últimas 10 conciliadas. */
export function inferirTarjetaPorHistorial(snap: SnapshotCorreos, comercioNorm: string): { tarjetaId: bigint; frecuencia: number } | null {
  if (!comercioNorm) return null;
  const porId = new Map(snap.compras.map((c) => [c.id, c]));
  const ids = snap.notificaciones
    .filter((n) => n.estado === 'CONCILIADO' && n.comercioNorm === comercioNorm)
    .map((n) => n.tarjetaId ?? (n.compraId !== null ? (porId.get(n.compraId)?.tarjetaId ?? null) : null));
  const d = dominante(ids);
  return d && d.frecuencia > 0.8 ? { tarjetaId: d.id, frecuencia: d.frecuencia } : null;
}

/** Paso 3 (cuenta): cuenta que el usuario asignó a este comercio/contraparte. */
export function inferirCuentaPorHistorial(snap: SnapshotCorreos, comercioNorm: string): { cuentaId: bigint; frecuencia: number } | null {
  if (!comercioNorm) return null;
  const porId = new Map(snap.transacciones.map((t) => [t.id, t]));
  const ids = snap.notificaciones
    .filter((n) => n.estado === 'CONCILIADO' && n.comercioNorm === comercioNorm)
    .map((n) => {
      if (n.cuentaId !== null) return n.cuentaId;
      const t = n.transaccionId !== null ? porId.get(n.transaccionId) : undefined;
      return t ? (t.cuentaDestinoId ?? t.cuentaOrigenId) : null;
    });
  const d = dominante(ids);
  return d && d.frecuencia > 0.8 ? { cuentaId: d.id, frecuencia: d.frecuencia } : null;
}

/** Paso 4: único candidato huérfano en ±36 h, mismo monto exacto y comercio similar (≥0.7). */
export function buscarCompraVentana36h(
  snap: SnapshotCorreos,
  q: { fecha: Date; monto: Decimal; moneda: 'COP' | 'USD'; comercioNorm: string; tarjetaId?: bigint | null },
): bigint | null {
  const candidatas = snap.compras.filter((c) => {
    if (c.vinculada) return false;
    if (q.tarjetaId && c.tarjetaId !== q.tarjetaId) return false;
    const montoOk = q.moneda === 'COP' ? c.moneda === 'COP' && c.valorCop.equals(q.monto) : c.moneda === 'USD' && (c.valorOriginal?.equals(q.monto) ?? false);
    if (!montoOk) return false;
    const centro = Date.parse(`${c.fecha}T12:00:00Z`);
    if (Math.abs(centro - q.fecha.getTime()) > VENTANA_36H_MS) return false;
    return similitudComercio(conceptoNormalizado(c), q.comercioNorm) >= 0.7;
  });
  return candidatas.length === 1 ? candidatas[0].id : null;
}

export function buscarTransaccionVentana36h(
  snap: SnapshotCorreos,
  q: { fecha: Date; monto: Decimal; comercioNorm: string },
): bigint | null {
  const candidatas = snap.transacciones.filter((t) => {
    if (t.vinculada || t.estado === 'ANULADO') return false;
    if (!t.montoCop.equals(q.monto)) return false;
    if (Math.abs(t.fecha.getTime() - q.fecha.getTime()) > VENTANA_36H_MS) return false;
    return similitudComercio(t.conceptoNorm ?? '', q.comercioNorm) >= 0.7;
  });
  return candidatas.length === 1 ? candidatas[0].id : null;
}
