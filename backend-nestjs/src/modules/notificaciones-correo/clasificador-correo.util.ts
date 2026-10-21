/**
 * Clasificador semántico determinista de intención de un correo bancario (Fase 1 + Iteración 2 Fase 1).
 * Funciones puras: sin BD ni Nest. Se evalúa ANTES de extraer una compra: un pago de tarjeta
 * o una compra rechazada nunca deben contaminar `ComprasCredito` ni `Transacciones`.
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
  /** Patrón exacto que activó el rechazo, si aplica. */
  patronRechazo?: string | null;
}

const ENTIDADES_HTML: Record<string, string> = {
  '&aacute;': 'a',
  '&eacute;': 'e',
  '&iacute;': 'i',
  '&oacute;': 'o',
  '&uacute;': 'u',
  '&ntilde;': 'n',
  '&uuml;': 'u',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Decodifica quoted-printable (`=C3=B3`, saltos `=\r\n`), entidades HTML (`&oacute;`, `&#243;`),
 * elimina etiquetas HTML (`<[^>]+>`), quita diacríticos y colapsa espacios en minúsculas.
 */
export function normalizarTextoCorreoMulticapa(raw: string | null | undefined): string {
  if (!raw) return '';
  let t = raw
    // Quoted-printable soft line breaks
    .replace(/=\r?\n/g, '')
    // Quoted-printable UTF-8 común en español (=C3=A1..=C3=BA)
    .replace(/=C3=([89AB][0-9A-F])/gi, (_m, hex: string) => {
      try {
        return Buffer.from([0xc3, parseInt(hex, 16)]).toString('utf8');
      } catch {
        return ' ';
      }
    })
    .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : ' ';
    });

  // Entidades HTML nombradas y numéricas
  t = t
    .replace(/&[a-z0-9#]+;/gi, (ent) => {
      const lower = ent.toLowerCase();
      if (ENTIDADES_HTML[lower] !== undefined) return ENTIDADES_HTML[lower];
      const dec = /^&#(\d+);$/.exec(lower);
      if (dec) return String.fromCharCode(Number(dec[1]));
      const hex = /^&#x([0-9a-f]+);$/.exec(lower);
      if (hex) return String.fromCharCode(parseInt(hex[1], 16));
      return ' ';
    })
    // Quitar tags HTML manteniendo espacios entre celdas/párrafos
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Diccionario multicapa de patrones de rechazo (Iteración 2 — Fase 1):
 * incluye frases directas y causales bancarias (Bancolombia, Nu, RappiCard, Codensa, Davivienda, Nequi).
 */
export const PATRONES_RECHAZO_TRANSACCION: ReadonlyArray<string> = [
  'no fue exitosa',
  'no se pudo realizar',
  'no se pudo procesar',
  'transaccion rechazada',
  'compra rechazada',
  'pago rechazado',
  'rechazo de compra',
  'operacion negada',
  'transaccion no aprobada',
  'transaccion fallida',
  'intento de compra',
  'intento de cobro',
  'anulacion de compra',
  'cancelada por el comercio',
  'cancelado por el comercio',
  'fondos insuficientes',
  'saldo insuficiente',
  'cupo disponible insuficiente',
  'cupo insuficiente',
  'supera el tope',
  'tarjeta bloqueada',
  'tarjeta inactiva',
  'cvv invalido',
  'codigo de seguridad errado',
  'fecha de vencimiento invalida',
  'comercio no permitido',
  'error en la transaccion',
  'declinada',
  'declinado',
  'rechazada',
  'rechazado',
  'reversada',
  'reversado',
  'bloqueada',
  'bloqueado',
];

/** Regex compilada de la Fase 1 sobre texto ya normalizado sin tildes. */
export const REGEX_RECHAZADA = new RegExp(
  `\\b(${PATRONES_RECHAZO_TRANSACCION.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

export const REGEX_PAGO_TARJETA =
  /\b(pago (exitoso )?(a|de) (tu )?tarjeta|abono a tarjeta|recibimos (el|tu) pago de tu tarjeta|pago de extracto|pago minimo|pago total de tu tarjeta|comprobante de pago tarjeta|pago tarjeta|abono tarjeta|abono deuda)\b/i;

/** Devuelve el patrón de rechazo detectado al inspeccionar múltiples capas de texto, o `null` si no hay rechazo. */
export function detectarPatronRechazo(textos: Array<string | null | undefined>): string | null {
  const combinado = normalizarTextoCorreoMulticapa(textos.filter(Boolean).join(' || '));
  if (!combinado) return null;
  for (const patron of PATRONES_RECHAZO_TRANSACCION) {
    const rx = new RegExp(`\\b${patron.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (rx.test(combinado)) return patron;
  }
  return null;
}

/** Inspección multicapa (`asunto` + `snippet` + `cuerpoTexto` + `cuerpoHtml` + `comercio`). */
export function esTransaccionRechazada(correo: {
  asunto?: string | null;
  snippet?: string | null;
  comercio?: string | null;
  cuerpoTexto?: string | null;
  cuerpoHtml?: string | null;
}): { rechazada: boolean; patronDetectado: string | null } {
  const patron = detectarPatronRechazo([
    correo.asunto,
    correo.snippet,
    correo.comercio,
    correo.cuerpoTexto,
    correo.cuerpoHtml,
  ]);
  return { rechazada: patron !== null, patronDetectado: patron };
}

export function esTextoRechazada(texto: string | null | undefined): boolean {
  return detectarPatronRechazo([texto]) !== null;
}

export function esTextoPagoTarjeta(texto: string | null | undefined): boolean {
  return !!texto && REGEX_PAGO_TARJETA.test(normalizarTextoCorreoMulticapa(texto));
}

/**
 * Clasifica por el texto disponible (asunto + comercio + snippet + cuerpo texto/HTML).
 */
export function clasificarIntencionCorreo(textos: Array<string | null | undefined>): ClasificacionCorreo {
  const t = normalizarTextoCorreoMulticapa(textos.filter(Boolean).join(' || '));
  if (!t) return { tipoIntencion: 'DESCONOCIDA', esCompraValida: false, tipoEvento: 'OTRO', patronRechazo: null };
  const patronRechazo = detectarPatronRechazo([t]);
  if (patronRechazo) {
    return { tipoIntencion: 'TRANSACCION_RECHAZADA', esCompraValida: false, tipoEvento: 'RECHAZADO', patronRechazo };
  }
  if (REGEX_PAGO_TARJETA.test(t)) return { tipoIntencion: 'PAGO_ABONO_TARJETA', esCompraValida: false, tipoEvento: 'PAGO_TARJETA', patronRechazo: null };
  if (/recibiste una transferencia|recibiste un pago/.test(t)) return { tipoIntencion: 'TRANSFERENCIA_RECIBIDA', esCompraValida: false, tipoEvento: 'OTRO', patronRechazo: null };
  if (/transferiste|enviaste una transferencia/.test(t)) return { tipoIntencion: 'TRANSFERENCIA_ENVIADA', esCompraValida: false, tipoEvento: 'OTRO', patronRechazo: null };
  if (/\bavance\b/.test(t)) return { tipoIntencion: 'AVANCE_TC', esCompraValida: true, tipoEvento: 'COMPRA_TC', patronRechazo: null };
  if (/notificacion informativa|inscripcion|clave dinamica|se vence el/.test(t)) return { tipoIntencion: 'INFORMATIVO', esCompraValida: false, tipoEvento: 'OTRO', patronRechazo: null };
  return { tipoIntencion: 'DESCONOCIDA', esCompraValida: false, tipoEvento: 'OTRO', patronRechazo: null };
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
