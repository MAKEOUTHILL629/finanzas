import { createHash } from 'node:crypto';
import { Decimal } from '../../config/decimal.config';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';

/** Lógica pura de la fase 6 del enlace de cobro: medios de pago, identidad de cada renglón y descuentos que resuelven una observación. */

// ───────────────────────────── medios de pago ─────────────────────────────

export const TIPOS_METODO_PAGO = ['CUENTA_AHORROS', 'CUENTA_CORRIENTE', 'NEQUI', 'DAVIPLATA', 'LLAVE', 'OTRO'] as const;
export type TipoMetodoPago = (typeof TIPOS_METODO_PAGO)[number];

/** Mensaje de error si el número no tiene sentido para ese tipo de medio (`null` = está bien). */
export function errorDeNumeroMetodo(tipo: TipoMetodoPago, numero: string): string | null {
  const n = numero.trim();
  if (n.length < 3) return 'Escribe el número, celular o llave';
  switch (tipo) {
    case 'CUENTA_AHORROS':
    case 'CUENTA_CORRIENTE': {
      const digitos = n.replace(/[\s-]/g, '');
      return /^\d{6,25}$/.test(digitos) ? null : 'El número de cuenta debe tener entre 6 y 25 dígitos';
    }
    case 'NEQUI':
    case 'DAVIPLATA': {
      const digitos = n.replace(/[\s-]/g, '');
      return /^(\+?57)?3\d{9}$/.test(digitos) ? null : 'El celular debe tener 10 dígitos y empezar por 3 (ej. 300 123 4567)';
    }
    case 'LLAVE':
      return /^[\w.+@:-]{3,60}$/u.test(n.replace(/\s/g, '')) ? null : 'La llave solo puede tener letras, números y . + @ : -';
    default:
      return null;
  }
}

/** Tipo de imagen del QR: solo imágenes, no PDF. */
export const TIPOS_QR = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_QR_BYTES = 400_000;

// ───────────────────────────── identidad de cada renglón ─────────────────────────────

interface ItemBase {
  fecha: string;
  concepto: string;
  impacto: number;
  origen: string;
  clave?: string;
}

/**
 * Identificador estable de un renglón del enlace (el snapshot no guarda ids de la base): el mismo cargo da siempre la misma clave
 * aunque se regenere la foto del enlace; si cambia su monto o su concepto, deja de coincidir y la observación queda con su texto.
 */
export function claveDeItem(bloque: string, item: Pick<ItemBase, 'fecha' | 'concepto' | 'impacto' | 'origen'>): string {
  const base = [bloque, item.fecha, item.concepto.trim().toLowerCase(), money(new Decimal(item.impacto)).toFixed(2), item.origen].join('|');
  return createHash('sha1').update(base).digest('hex').slice(0, 16);
}

/** Pone `clave` a cada renglón que no la tenga (las fotos viejas del enlace se generaron antes de la fase 6). */
export function asegurarClaves<T extends { bloques: Array<{ clave: string; items: ItemBase[] }> }>(snapshot: T): T {
  for (const b of snapshot.bloques ?? []) {
    for (const i of b.items) if (!i.clave) i.clave = claveDeItem(b.clave, i);
  }
  return snapshot;
}

export interface ItemLocalizado {
  bloque: string;
  clave: string;
  concepto: string;
  fecha: string;
  /** Lo que la persona ve para ese renglón (positivo = cargo; negativo = abono). */
  impacto: number;
}

/** Busca un renglón por su clave dentro de la foto del enlace. */
export function buscarItem(snapshot: { bloques: Array<{ clave: string; items: ItemBase[] }> }, clave: string): ItemLocalizado | null {
  for (const b of snapshot.bloques ?? []) {
    for (const i of b.items) {
      const k = i.clave ?? claveDeItem(b.clave, i);
      if (k === clave) return { bloque: b.clave, clave: k, concepto: i.concepto, fecha: i.fecha, impacto: i.impacto };
    }
  }
  return null;
}

// ───────────────────────────── resolver una observación ─────────────────────────────

export type AccionObjecion = 'MANTENER' | 'AJUSTAR' | 'EXCLUIR' | 'DESCUENTO';
export const ACCIONES_OBJECION: ReadonlyArray<AccionObjecion> = ['MANTENER', 'AJUSTAR', 'EXCLUIR', 'DESCUENTO'];

export interface EntradaResolucion {
  accion: AccionObjecion;
  /** AJUSTAR: el monto NUEVO que se le cobra por ese renglón. DESCUENTO: lo que se descuenta del saldo. */
  monto?: number | string | null;
  /** Lo que la persona veía en el renglón objetado (`null` si objetó el total). */
  itemMonto: Decimal | null;
  /** Lo que debe hoy (tope de un descuento directo). */
  saldoPendiente: Decimal | null;
}

/**
 * Cuánto se le descuenta a la persona por esta resolución (`null` si no se toca su saldo). Reglas:
 *  - AJUSTAR: solo cobros (renglón > 0); el nuevo monto va de 0 a menos que el actual → descuento = actual − nuevo.
 *  - EXCLUIR: solo cobros; se descuenta el renglón completo.
 *  - DESCUENTO: cualquier monto > 0 que no pase de lo que debe.
 */
export function descuentoDeResolucion(e: EntradaResolucion): Decimal | null {
  switch (e.accion) {
    case 'MANTENER':
      return null;
    case 'AJUSTAR': {
      if (!e.itemMonto || !e.itemMonto.greaterThan(0)) throw datosInvalidos({ accion: ['Solo se puede ajustar el monto de un cobro (no de un abono ni del total)'] });
      if (e.monto === undefined || e.monto === null || e.monto === '') throw datosInvalidos({ monto: ['Indica el monto nuevo a cobrar'] });
      const nuevo = money(toDecimal(e.monto));
      if (nuevo.isNegative()) throw datosInvalidos({ monto: ['El monto no puede ser negativo'] });
      if (!nuevo.lessThan(e.itemMonto)) throw datosInvalidos({ monto: [`El monto nuevo debe ser menor a lo cobrado (${money(e.itemMonto).toString()})`] });
      return money(e.itemMonto.minus(nuevo));
    }
    case 'EXCLUIR': {
      if (!e.itemMonto || !e.itemMonto.greaterThan(0)) throw datosInvalidos({ accion: ['Solo se puede excluir un cobro (no un abono ni el total)'] });
      return money(e.itemMonto);
    }
    case 'DESCUENTO': {
      if (e.monto === undefined || e.monto === null || e.monto === '') throw datosInvalidos({ monto: ['Indica cuánto descuentas'] });
      const d = money(toDecimal(e.monto));
      if (!d.greaterThan(0)) throw datosInvalidos({ monto: ['El descuento debe ser mayor a 0'] });
      if (e.saldoPendiente && d.greaterThan(e.saldoPendiente)) {
        throw datosInvalidos({ monto: [`El descuento no puede pasar de lo que debe hoy (${money(e.saldoPendiente).toString()})`] });
      }
      return d;
    }
    default:
      throw datosInvalidos({ accion: ['Acción no válida'] });
  }
}

const COP = (d: Decimal): string => `$${money(d).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** Texto del asiento que queda en el libro de deudas (lo ve la propia persona en su enlace). */
export function conceptoDeAjuste(a: { accion: AccionObjecion; itemConcepto: string | null; itemMonto: Decimal | null; descuento: Decimal; motivo?: string | null }): string {
  const motivo = a.motivo?.trim();
  let base: string;
  if (a.accion === 'AJUSTAR' && a.itemConcepto && a.itemMonto) base = `Ajuste de «${a.itemConcepto}»: de ${COP(a.itemMonto)} a ${COP(a.itemMonto.minus(a.descuento))}`;
  else if (a.accion === 'EXCLUIR' && a.itemConcepto) base = `Cobro excluido: «${a.itemConcepto}»`;
  else base = `Descuento del propietario${motivo ? `: ${motivo}` : ''}`;
  return base.slice(0, 255);
}
