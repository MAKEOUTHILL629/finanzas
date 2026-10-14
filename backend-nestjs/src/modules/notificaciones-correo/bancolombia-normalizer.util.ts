import { Decimal } from '../../config/decimal.config';
import { tryToDecimal } from '../../common/utils/decimal.util';

/**
 * Normalizador de los correos de Bancolombia procesados por el Google Apps Script
 * ("Control de gastos automático"). Funciones puras: sin BD ni Nest.
 */

export type RutaSync = 'IGNORAR' | 'COMPRA_TC' | 'PAGO_TARJETA' | 'INGRESO' | 'EGRESO' | 'SIN_RUTA';
export type Instrumento = 'TC' | 'CUENTA';

const sinTildes = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Últimos 4 dígitos de un producto. Unifica todas las variantes que emite el banco:
 * `cta *3698`, `Cuenta *3698`, `Cuenta 3698`, `producto *3698`, `T.Cred *1927`, `T.Cred  *1927`,
 * `Tarjeta de credito *1927`, `*4278`…  (regex del plan: `/\*?\s*(\d{4})\b/`, con guarda para no tomar
 * 4 dígitos del medio de un número más largo).
 */
export function extraerUltimos4(origenRaw: string | null | undefined): string | null {
  if (!origenRaw) return null;
  const m = /\*?\s*(?<!\d)(\d{4})(?!\d)/.exec(origenRaw);
  return m ? m[1] : null;
}

/** ¿El origen es una tarjeta de crédito? (por el texto del origen o por el método reportado). */
export function detectarInstrumento(origenRaw: string | null | undefined, metodo: string | null | undefined): Instrumento {
  const texto = sinTildes(`${origenRaw ?? ''}`).toLowerCase();
  if (/\bt\.?\s*cred\b|tarjeta\s+de\s+credito|tarjeta\s+credito/.test(texto)) return 'TC';
  if (sinTildes(metodo ?? '').toLowerCase() === 'tarjeta credito') return 'TC';
  return 'CUENTA';
}

const AVISOS_INFORMATIVOS = ['se vence el', 'inscribiste', 'registraste tu llave'];

/** Correos informativos que no son movimientos de dinero (vencimientos, inscripciones, llaves). */
export function esAvisoInformativo(asunto: string | null | undefined): boolean {
  const texto = sinTildes(asunto ?? '').toLowerCase();
  return AVISOS_INFORMATIVOS.some((a) => texto.includes(a));
}

export interface ItemParaRuteo {
  tipo: string;
  metodo: string;
  asunto?: string | null;
  esErrorParsing?: boolean | null;
  origenRaw?: string | null;
}

/**
 * Enrutamiento transaccional del plan:
 *  1. error de parseo o aviso informativo           → IGNORAR  (estado_procesamiento = IGNORADO)
 *  2. Tarjeta Credito + Compra/Avance               → COMPRA_TC (ComprasCredito a 1 cuota)
 *  3. Pago Tarjeta | Abono Tarjeta | Abono Deuda    → PAGO_TARJETA (con deduplicación ±5 min)
 *  4. Ingreso | Pago Proveedor                      → INGRESO
 *  5. Transferencia | Pago | Retiro | Compra (cuenta/débito) → EGRESO
 *  cualquier otra combinación                       → SIN_RUTA (queda PENDIENTE para revisión manual)
 */
export function decidirRuta(item: ItemParaRuteo): RutaSync {
  if (item.esErrorParsing === true || esAvisoInformativo(item.asunto)) return 'IGNORAR';

  const tipo = sinTildes(item.tipo).trim().toLowerCase();
  const metodo = sinTildes(item.metodo).trim().toLowerCase();
  const instrumento = detectarInstrumento(item.origenRaw, item.metodo);

  if (metodo === 'tarjeta credito' && (tipo === 'compra' || tipo === 'avance')) return 'COMPRA_TC';
  if (metodo === 'pago tarjeta' || tipo === 'abono tarjeta' || tipo === 'abono deuda') return 'PAGO_TARJETA';
  if (tipo === 'ingreso' || tipo === 'pago proveedor') return 'INGRESO';
  if (['transferencia', 'pago', 'retiro', 'compra'].includes(tipo) && instrumento === 'CUENTA' && metodo !== 'tarjeta credito') {
    return 'EGRESO';
  }
  return 'SIN_RUTA';
}

/** Prioridad al ordenar un lote: el débito en cuenta precede al abono en tarjeta del mismo pago. */
export function prioridadRuta(item: ItemParaRuteo): number {
  const tipo = sinTildes(item.tipo).trim().toLowerCase();
  if (tipo === 'abono tarjeta' || tipo === 'abono deuda') return 1;
  return 0;
}

/**
 * Convierte el valor textual del banco a Decimal. Reglas:
 *  - ambos separadores → el ÚLTIMO es el decimal, el otro es de miles ("1.234,56" / "1,234.56").
 *  - solo ',' → miles si son grupos de 3 dígitos ("1,234"), si no decimal ("50,5").
 *  - solo '.' → miles si son grupos de 3 dígitos y la moneda es COP ("50.000"), si no decimal ("49.99").
 */
export function parseMontoBancolombia(valor: string | number | null | undefined, moneda: 'COP' | 'USD' = 'COP'): Decimal | null {
  if (valor === null || valor === undefined) return null;
  let texto = String(valor).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(texto)) return null;
  const negativo = texto.startsWith('-');
  texto = texto.replace(/-/g, '');

  const tienePunto = texto.includes('.');
  const tieneComa = texto.includes(',');
  let normalizado: string;

  if (tienePunto && tieneComa) {
    const decimalEsComa = texto.lastIndexOf(',') > texto.lastIndexOf('.');
    normalizado = decimalEsComa ? texto.replace(/\./g, '').replace(',', '.') : texto.replace(/,/g, '');
  } else if (tieneComa) {
    normalizado = /^\d{1,3}(,\d{3})+$/.test(texto) ? texto.replace(/,/g, '') : texto.replace(',', '.');
  } else if (tienePunto) {
    normalizado = moneda === 'COP' && /^\d{1,3}(\.\d{3})+$/.test(texto) ? texto.replace(/\./g, '') : texto;
  } else {
    normalizado = texto;
  }

  const d = tryToDecimal(normalizado);
  if (!d) return null;
  return negativo ? d.negated() : d;
}

/** `fecha` (YYYY-MM-DD) + `hora` (HH:mm[:ss]) en la zona del buzón (por defecto Bogotá, -05:00) → instante UTC. */
export function construirFechaHora(fecha: string, hora: string, offset = '-05:00'): Date | null {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha.trim());
  const h = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hora.trim());
  if (!f || !h) return null;
  const iso = `${f[1]}-${f[2]}-${f[3]}T${h[1]}:${h[2]}:${h[3] ?? '00'}${offset}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Tokens de 4 dígitos presentes en un texto (p. ej. `"3698, 4278"` o `"Visa Oro *1927"`). */
export function tokensDe4Digitos(texto: string | null | undefined): string[] {
  if (!texto) return [];
  return [...texto.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]);
}

export interface CuentaCandidata {
  id: bigint;
  ultimos_4_digitos: string | null;
  moneda?: string;
}

export interface TarjetaCandidata {
  id: bigint;
  descripcion: string | null;
  franquicia: string | null;
  tasa_interes_compra?: { toString(): string } | null;
  tasa_interes_avance?: { toString(): string } | null;
}

/**
 * Cuenta que corresponde a los últimos 4 dígitos. `CuentasFinancieras.ultimos_4_digitos` admite VARIOS valores
 * separados por coma/espacio ("3698,4278,7992": cuenta + sus tarjetas débito). Solo se resuelve si es inequívoca.
 */
export function resolverCuenta<T extends CuentaCandidata>(cuentas: T[], ultimos4: string | null): T | null {
  if (!ultimos4) return null;
  const coincidencias = cuentas.filter((c) => tokensDe4Digitos(c.ultimos_4_digitos).includes(ultimos4));
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

/**
 * Tarjeta de crédito que corresponde a los últimos 4 dígitos. `Tarjetas` no tiene columna propia: el número
 * debe estar en `descripcion` o `franquicia` (p. ej. "Visa Oro *1927"). Solo si es inequívoca.
 */
export function resolverTarjeta<T extends TarjetaCandidata>(tarjetas: T[], ultimos4: string | null): T | null {
  if (!ultimos4) return null;
  const coincidencias = tarjetas.filter((t) => tokensDe4Digitos(`${t.descripcion ?? ''} ${t.franquicia ?? ''}`).includes(ultimos4));
  return coincidencias.length === 1 ? coincidencias[0] : null;
}
