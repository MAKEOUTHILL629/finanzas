/**
 * Clasificador semántico determinista de intención de un correo bancario (Fase 1).
 * Funciones puras: sin BD ni Nest. Se evalúa ANTES de extraer una compra: un pago de tarjeta
 * o una compra rechazada nunca deben contaminar `ComprasCredito`.
 */
import { createHash } from 'node:crypto';
import { normalizarComercio } from './comercio.util';

export type TipoIntencionCorreo =
  | 'TRANSACCION_RECHAZADA'
  | 'PAGO_ABONO_TARJETA'
  | 'COMPRA_TC'
  | 'TRANSFERENCIA_RECIBIDA'
  | 'TRANSFERENCIA_ENVIADA'
  | 'AVANCE_TC'
  | 'INFORMATIVO'
  | 'DESCONOCIDA';

export interface ClasificacionCorreo {
  tipoIntencion: TipoIntencionCorreo;
  /** Solo las compras TC reales (y avances) son compras válidas. */
  esCompraValida: boolean;
  /** Valor sugerido para `tipo_evento` en datos_parseados. */
  tipoEvento: 'PAGO_TARJETA' | 'COMPRA_TC' | 'RECHAZADO' | 'OTRO';
}

const plano = (t: string): string =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Regex de la Fase 1 (insensible a mayúsculas/acentos: el texto ya viene «plano»). */
export const REGEX_RECHAZADA =
  /\b(no fue exitosa|no se pudo realizar|rechazad[ao]|declinad[ao]|transaccion fallida|fondos insuficientes|cupo insuficiente|intento de compra|bloquead[ao]|cancelad[ao] por el comercio)\b/i;

export const REGEX_PAGO_TARJETA =
  /\b(pago (exitoso )?(a|de) (tu )?tarjeta|abono a tarjeta|recibimos (el|tu) pago de tu tarjeta|pago de extracto|pago minimo|pago total de tu tarjeta|comprobante de pago tarjeta|pago tarjeta|abono tarjeta|abono deuda)\b/i;

export function esTextoRechazada(texto: string | null | undefined): boolean {
  return !!texto && REGEX_RECHAZADA.test(plano(texto));
}

export function esTextoPagoTarjeta(texto: string | null | undefined): boolean {
  return !!texto && REGEX_PAGO_TARJETA.test(plano(texto));
}

/**
 * Clasifica por el texto disponible (asunto + comercio + cuerpo). La ruta Apps Script
 * (`tipo`/`metodo`) se respeta como respaldo en `decidirRuta`; aquí manda la semántica.
 */
export function clasificarIntencionCorreo(textos: Array<string | null | undefined>): ClasificacionCorreo {
  const t = plano(textos.filter(Boolean).join(' '));
  if (!t) return { tipoIntencion: 'DESCONOCIDA', esCompraValida: false, tipoEvento: 'OTRO' };
  if (REGEX_RECHAZADA.test(t)) return { tipoIntencion: 'TRANSACCION_RECHAZADA', esCompraValida: false, tipoEvento: 'RECHAZADO' };
  if (REGEX_PAGO_TARJETA.test(t)) return { tipoIntencion: 'PAGO_ABONO_TARJETA', esCompraValida: false, tipoEvento: 'PAGO_TARJETA' };
  if (/recibiste una transferencia|recibiste un pago/.test(t)) return { tipoIntencion: 'TRANSFERENCIA_RECIBIDA', esCompraValida: false, tipoEvento: 'OTRO' };
  if (/transferiste|enviaste una transferencia/.test(t)) return { tipoIntencion: 'TRANSFERENCIA_ENVIADA', esCompraValida: false, tipoEvento: 'OTRO' };
  if (/\bavance\b/.test(t)) return { tipoIntencion: 'AVANCE_TC', esCompraValida: true, tipoEvento: 'COMPRA_TC' };
  if (/notificacion informativa|inscripcion|clave dinamica|se vence el/.test(t)) return { tipoIntencion: 'INFORMATIVO', esCompraValida: false, tipoEvento: 'OTRO' };
  return { tipoIntencion: 'DESCONOCIDA', esCompraValida: false, tipoEvento: 'OTRO' };
}

/**
 * Huella determinista de sincronización (Fase 1, paso 1):
 * SHA256(fecha_trunc_minuto + monto_centavos + ultimos4 + comercio_slug).
 * Si un correo se re-sincroniza con otro ID temporal, la huella permite recuperar lo ya creado.
 */
export function generarHuellaSincronizacion(p: {
  fecha: Date | null;
  montoCentavos: string | number | null;
  ultimos4: string | null;
  comercio: string | null | undefined;
}): string {
  const minuto = p.fecha ? p.fecha.toISOString().slice(0, 16) : '';
  const base = `${minuto}|${p.montoCentavos ?? ''}|${p.ultimos4 ?? ''}|${normalizarComercio(p.comercio)}`;
  return createHash('sha256').update(base).digest('hex');
}
