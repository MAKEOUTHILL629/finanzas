import { Decimal } from '../../config/decimal.config';
import { money, sumDecimals, toDecimal } from '../../common/utils/decimal.util';

/**
 * Motor de extracción y correlación de identidades de transferencia (Iteración 3 · Fase 5).
 * Funciones puras: analizan el texto de una transferencia (descripción, notas, cuerpo de correo)
 * y agrupan los movimientos por destinatario / llave / cuenta. Sin BD ni Nest.
 */

export interface IdentidadTransferencia {
  /** El texto sugiere una transferencia a un tercero (llave, envío, destinatario…). */
  esTransferencia: boolean;
  /** Nombre del destinatario tal como aparece (sin normalizar). */
  nombreDestinatario: string | null;
  /** Nombre normalizado (sin tildes, mayúsculas) para agrupar. */
  nombreNormalizado: string | null;
  /** Llave Bre-B / Transfiya / alias (@…) o correo llave. */
  llave: string | null;
  /** Celular colombiano detectado (10 dígitos, empieza en 3). */
  celular: string | null;
  /** Número o máscara de la cuenta destino. */
  cuentaDestino: string | null;
  /** Entidad/canal detectado: Bancolombia, Nequi, Daviplata, Davivienda, Nu, Lulo, Bre-B… */
  entidad: string | null;
}

const sinTildes = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nombre comparable entre fuentes: sin tildes, en mayúsculas y con espacios colapsados. */
export function normalizarNombreDestinatario(nombre: string | null | undefined): string | null {
  if (!nombre) return null;
  const limpio = sinTildes(nombre).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return limpio.length >= 3 ? limpio : null;
}

const ENTIDADES: Array<[RegExp, string]> = [
  [/bancolombia/i, 'Bancolombia'],
  [/nequi/i, 'Nequi'],
  [/daviplata/i, 'Daviplata'],
  [/davivienda/i, 'Davivienda'],
  [/bre-b|breb/i, 'Bre-B'],
  [/transfiya/i, 'Transfiya'],
  [/\bnu\b|nubank/i, 'Nu'],
  [/lulo/i, 'Lulo'],
  [/\bpse\b/i, 'PSE'],
];

const PALABRAS_TRANSFERENCIA = /(transferencia|transferir|enviaste|envio|enviado|llave|transfiya|bre-b|breb|consignacion|giro)/i;

/** Extrae destinatario, llave/celular, cuenta y entidad de un texto libre de transferencia. */
export function extraerIdentidadTransferencia(texto: string | null | undefined): IdentidadTransferencia {
  const t = (texto ?? '').replace(/\s+/g, ' ').trim();
  const vacia: IdentidadTransferencia = {
    esTransferencia: false,
    nombreDestinatario: null,
    nombreNormalizado: null,
    llave: null,
    celular: null,
    cuentaDestino: null,
    entidad: null,
  };
  if (!t) return vacia;

  const celular = /\b(3\d{9})\b/.exec(t)?.[1] ?? null;

  let llave: string | null = null;
  const mLlave = /llave\s*[:#-]?\s*(@?[a-zA-Z0-9][a-zA-Z0-9@._+-]*)/i.exec(t);
  if (mLlave) llave = mLlave[1].replace(/[.,;]+$/, '');
  if (!llave) {
    const mAlias = /\B(@[a-zA-Z0-9][a-zA-Z0-9._-]{2,})/.exec(t);
    if (mAlias) llave = mAlias[1];
  }
  if (!llave && celular && /(llave|nequi|transfiya|bre-b|celular|telefono)/i.test(t)) llave = celular;

  let cuentaDestino: string | null = null;
  const mCuenta = /(?:cuenta|cta|producto|destino)\s*(?:no\.?|nro\.?|#|:)?\s*([*xX\d][\d*xX-]{3,24})/i.exec(t);
  if (mCuenta) cuentaDestino = mCuenta[1].replace(/-+$/, '');

  let nombreDestinatario: string | null = null;
  const mNombre = /(?:a nombre de|destinatario|transferencia a|enviaste a|transferiste a|para)\s*[:#-]?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,5})/i.exec(t);
  if (mNombre) {
    nombreDestinatario = mNombre[1]
      .split(/\s+(?:por|desde|vía|via|en|con|cuenta|cta|llave)\s+/i)[0]
      .replace(/\s+(bancolombia|nequi|daviplata|davivienda|transfiya|bre-b|lulo|nu)$/i, '')
      .trim();
    if (normalizarNombreDestinatario(nombreDestinatario) === null) nombreDestinatario = null;
  }

  const entidad = ENTIDADES.find(([re]) => re.test(t))?.[1] ?? null;
  const esTransferencia = PALABRAS_TRANSFERENCIA.test(t) || llave !== null || cuentaDestino !== null || nombreDestinatario !== null;

  return {
    esTransferencia,
    nombreDestinatario,
    nombreNormalizado: normalizarNombreDestinatario(nombreDestinatario),
    llave,
    celular,
    cuentaDestino,
    entidad,
  };
}

export interface MovimientoTransferencia {
  id: number;
  tipo: string;
  monto: number | string | Decimal;
  fecha: string;
  nombreNormalizado: string | null;
  llave: string | null;
  cuentaDestino: string | null;
  entidad: string | null;
  personaId: number | null;
  personaNombre: string | null;
}

export interface GrupoDestinatario {
  clave: string;
  nombre: string;
  personaId: number | null;
  totalEnviado: number;
  totalRecibido: number;
  cantidadOperaciones: number;
  promedioTransferencia: number;
  ultimaFecha: string | null;
  identificadoresAsociados: string[];
}

/** Agrupa movimientos por persona (si se resolvió) o por nombre normalizado / llave / cuenta. */
export function agruparPorDestinatario(movimientos: ReadonlyArray<MovimientoTransferencia>): GrupoDestinatario[] {
  const grupos = new Map<string, { datos: GrupoDestinatario; suma: Decimal; enviado: Decimal; recibido: Decimal; ids: Set<string> }>();
  for (const m of movimientos) {
    const clave = m.personaId !== null ? `persona:${m.personaId}` : m.nombreNormalizado ? `nombre:${m.nombreNormalizado}` : m.llave ? `llave:${m.llave}` : m.cuentaDestino ? `cuenta:${m.cuentaDestino}` : 'sin-identificar';
    const nombre = m.personaNombre ?? m.nombreNormalizado ?? m.llave ?? m.cuentaDestino ?? 'Sin identificar';
    const monto = toDecimal(m.monto);
    const esEnviado = m.tipo === 'EGRESO' || m.tipo === 'TRANSFERENCIA';
    const g = grupos.get(clave) ?? {
      datos: {
        clave,
        nombre,
        personaId: m.personaId,
        totalEnviado: 0,
        totalRecibido: 0,
        cantidadOperaciones: 0,
        promedioTransferencia: 0,
        ultimaFecha: null,
        identificadoresAsociados: [],
      },
      suma: new Decimal(0),
      enviado: new Decimal(0),
      recibido: new Decimal(0),
      ids: new Set<string>(),
    };
    g.suma = g.suma.plus(monto);
    if (esEnviado) g.enviado = g.enviado.plus(monto);
    else g.recibido = g.recibido.plus(monto);
    g.datos.cantidadOperaciones++;
    if (!g.datos.ultimaFecha || m.fecha > g.datos.ultimaFecha) g.datos.ultimaFecha = m.fecha;
    if (m.personaNombre && !g.datos.personaId && m.personaId !== null) g.datos.personaId = m.personaId;
    for (const ident of [m.llave, m.cuentaDestino, m.nombreNormalizado]) if (ident) g.ids.add(ident);
    grupos.set(clave, g);
  }
  return [...grupos.values()]
    .map((g) => ({
      ...g.datos,
      totalEnviado: money(g.enviado).toNumber(),
      totalRecibido: money(g.recibido).toNumber(),
      promedioTransferencia: g.datos.cantidadOperaciones > 0 ? money(g.suma.div(g.datos.cantidadOperaciones)).toNumber() : 0,
      identificadoresAsociados: [...g.ids],
    }))
    .sort((a, b) => b.totalEnviado + b.totalRecibido - (a.totalEnviado + a.totalRecibido));
}

/** Serie mensual (YYYY-MM) de enviado/recibido para el gráfico evolutivo. */
export function serieMensualTransferencias(movimientos: ReadonlyArray<MovimientoTransferencia>): Array<{ periodo: string; enviado: number; recibido: number; cantidad: number }> {
  const porPeriodo = new Map<string, { enviado: Decimal; recibido: Decimal; cantidad: number }>();
  for (const m of movimientos) {
    const periodo = m.fecha.slice(0, 7);
    const fila = porPeriodo.get(periodo) ?? { enviado: new Decimal(0), recibido: new Decimal(0), cantidad: 0 };
    if (m.tipo === 'EGRESO' || m.tipo === 'TRANSFERENCIA') fila.enviado = fila.enviado.plus(toDecimal(m.monto));
    else fila.recibido = fila.recibido.plus(toDecimal(m.monto));
    fila.cantidad++;
    porPeriodo.set(periodo, fila);
  }
  return [...porPeriodo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodo, f]) => ({ periodo, enviado: money(f.enviado).toNumber(), recibido: money(f.recibido).toNumber(), cantidad: f.cantidad }));
}

export function totalDe(movimientos: ReadonlyArray<MovimientoTransferencia>): Decimal {
  return money(sumDecimals(movimientos.map((m) => toDecimal(m.monto))));
}
