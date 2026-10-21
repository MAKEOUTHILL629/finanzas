import { Decimal } from '../../config/decimal.config';
import { tryToDecimal } from '../../common/utils/decimal.util';
import { detectarPatronRechazo } from './clasificador-correo.util';
import { InterpretacionCuerpo } from './cuerpo-correo.util';

/**
 * Normalizador de los correos de Bancolombia procesados por el Google Apps Script
 * ("Control de gastos automático"). Funciones puras: sin BD ni Nest.
 */

export type RutaSync = 'IGNORAR' | 'COMPRA_TC' | 'PAGO_TARJETA' | 'INGRESO' | 'EGRESO' | 'SIN_RUTA';
export type Instrumento = 'TC' | 'CUENTA';

const sinTildes = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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
  comercio?: string | null;
  esErrorParsing?: boolean | null;
  origenRaw?: string | null;
}

/**
 * Motivo por el que un correo se ignora (null si no hay que ignorarlo). El cuerpo (opcional) permite reconocer lo que
 * el Apps Script deja como «Desconocido»: compras rechazadas por fondos insuficientes y avisos de inscripción.
 */
export function motivoIgnorar(item: ItemParaRuteo, cuerpo?: InterpretacionCuerpo | null): string | null {
  if (cuerpo?.rechazada || detectarPatronRechazo([item.asunto, item.comercio, item.tipo]) !== null) {
    return 'compra_rechazada_o_no_exitosa';
  }
  if (item.esErrorParsing === true || esAvisoInformativo(item.asunto) || cuerpo?.informativo) return 'aviso_informativo_o_error_de_parseo';
  return null;
}

/**
 * Enrutamiento transaccional del plan:
 *  1. error de parseo, aviso informativo o compra rechazada → IGNORAR  (estado_procesamiento = IGNORADO / DESCARTADO_RECHAZADO)
 *  2. Compra/Avance con tarjeta de crédito (cualquier método) → COMPRA_TC (ComprasCredito)
 *  3. Pago Tarjeta | Abono Tarjeta | Abono Deuda    → PAGO_TARJETA (con deduplicación ±5 min)
 *  4. Ingreso | Pago Proveedor | transferencia recibida (cuerpo) → INGRESO
 *  5. Transferencia | Pago | Retiro | Compra (cuenta/débito) → EGRESO
 *  cualquier otra combinación                       → SIN_RUTA (queda PENDIENTE para revisión manual)
 */
export function decidirRuta(item: ItemParaRuteo, cuerpo?: InterpretacionCuerpo | null): RutaSync {
  if (motivoIgnorar(item, cuerpo)) return 'IGNORAR';

  const tipo = sinTildes(item.tipo).trim().toLowerCase();
  const metodo = sinTildes(item.metodo).trim().toLowerCase();
  const instrumento = detectarInstrumento(item.origenRaw, item.metodo);

  // Fase 1: un pago/abono de tarjeta jamás es una compra, aunque el Apps Script lo rotule «Compra».
  if (cuerpo?.pagoTarjeta) return 'PAGO_TARJETA';
  const textoLibre = sinTildes(`${item.asunto ?? ''} ${item.comercio ?? ''}`).toLowerCase();
  if (/\b(pago (exitoso )?(a|de) (tu )?tarjeta|recibimos (el|tu) pago|pago de extracto|comprobante de pago tarjeta)\b/.test(textoLibre)) return 'PAGO_TARJETA';

  if ((tipo === 'compra' || tipo === 'avance') && (metodo === 'tarjeta credito' || instrumento === 'TC')) return 'COMPRA_TC';
  if (metodo === 'pago tarjeta' || tipo === 'abono tarjeta' || tipo === 'abono deuda') return 'PAGO_TARJETA';
  if (tipo === 'ingreso' || tipo === 'pago proveedor') return 'INGRESO';
  if (tipo === 'desconocido' && cuerpo?.recibida) return 'INGRESO';
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
  /** Cuenta que recibe los avisos del banco que no traen número. */
  es_principal?: boolean | null;
}

export interface TarjetaCandidata {
  id: bigint;
  descripcion: string | null;
  franquicia: string | null;
  /** Últimos 4 dígitos (varios separados por coma si se reexpidió la tarjeta). */
  ultimos_4_digitos?: string | null;
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
 * Cuenta para un aviso del banco: la que coincide con los últimos 4 dígitos o, si el aviso NO trae número
 * («en tu cuenta de Ahorros»), la cuenta marcada como principal. Con número desconocido no se adivina.
 */
export function resolverCuentaOPrincipal<T extends CuentaCandidata>(cuentas: T[], ultimos4: string | null): T | null {
  if (ultimos4) return resolverCuenta(cuentas, ultimos4);
  const principales = cuentas.filter((c) => c.es_principal === true);
  return principales.length === 1 ? principales[0] : null;
}

/**
 * Tarjeta de crédito que corresponde a los últimos 4 dígitos. Primero la columna `Tarjetas.ultimos_4_digitos`
 * (varios valores si se reexpidió); si ninguna la tiene, el número escrito en `descripcion`/`franquicia`
 * ("Visa Oro *1927"), que es como se identificaba antes. Solo si es inequívoca.
 */
export function resolverTarjeta<T extends TarjetaCandidata>(tarjetas: T[], ultimos4: string | null): T | null {
  if (!ultimos4) return null;
  const porColumna = tarjetas.filter((t) => tokensDe4Digitos(t.ultimos_4_digitos).includes(ultimos4));
  if (porColumna.length > 0) return porColumna.length === 1 ? porColumna[0] : null;
  const coincidencias = tarjetas.filter((t) => tokensDe4Digitos(`${t.descripcion ?? ''} ${t.franquicia ?? ''}`).includes(ultimos4));
  return coincidencias.length === 1 ? coincidencias[0] : null;
}
