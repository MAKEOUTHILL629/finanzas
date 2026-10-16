/**
 * Lógica PURA de tipos de tarjeta (crédito / débito) y del estado de cada plástico dentro de su línea. Sin base de datos.
 *
 * Una tarjeta de débito cuelga de una cuenta y nunca tiene compras a crédito; la de crédito puede tener una cuenta opcional.
 * Los plásticos de una línea se encadenan por fechas: el activo es el vigente y los demás son «reemplazados» (si la línea siguió con
 * otro plástico después) o «inactivos» (históricos sin continuidad).
 */
import { tokensUltimos4 } from './plasticos.util';

export const TIPOS_TARJETA = ['CREDITO', 'DEBITO'] as const;
export type TipoTarjeta = (typeof TIPOS_TARJETA)[number];

export const ESTADOS_PLASTICO = ['ACTIVA', 'INACTIVA', 'REEMPLAZADA'] as const;
export type EstadoPlastico = (typeof ESTADOS_PLASTICO)[number];

export const esDebito = (t: { tipo_tarjeta?: string | null }): boolean => t.tipo_tarjeta === 'DEBITO';

/** Las tarjetas que admiten compras a crédito, extractos y cupo (todo lo que no sea explícitamente de débito). */
export function soloCredito<T extends { tipo_tarjeta?: string | null }>(tarjetas: T[]): T[] {
  return tarjetas.filter((t) => !esDebito(t));
}

/**
 * Cuentas con los últimos 4 de sus tarjetas de débito añadidos a su lista: así un aviso del banco con los dígitos de la tarjeta de
 * débito (que no es el número de cuenta) se reconoce como movimiento de esa cuenta. No modifica las filas de la base.
 */
export function cuentasConDebitos<C extends { id: bigint; ultimos_4_digitos: string | null }, T extends { tipo_tarjeta?: string | null; cuenta_id?: bigint | null; ultimos_4_digitos?: string | null }>(
  cuentas: C[],
  tarjetas: T[],
): C[] {
  const debitos = tarjetas.filter((t) => esDebito(t) && t.cuenta_id !== null && t.cuenta_id !== undefined);
  if (debitos.length === 0) return cuentas;
  return cuentas.map((c) => {
    const propios = debitos.filter((d) => d.cuenta_id === c.id).flatMap((d) => tokensUltimos4(d.ultimos_4_digitos));
    if (propios.length === 0) return c;
    const todos = [...new Set([...tokensUltimos4(c.ultimos_4_digitos), ...propios])];
    return { ...c, ultimos_4_digitos: todos.join(',') };
  });
}

export interface PlasticoConFechas {
  id: number;
  esActivo: boolean;
  vigenteDesde: string | null;
  vigenteHasta: string | null;
  reemplazaAId?: number | null;
}

/**
 * Estado de cada plástico de una MISMA línea:
 *  · ACTIVA     — es el vigente.
 *  · REEMPLAZADA — ya no está vigente y la línea siguió con otro plástico (uno posterior o el activo).
 *  · INACTIVA   — histórico sin plástico posterior.
 */
export function estadosDePlasticos(plasticos: PlasticoConFechas[]): Map<number, EstadoPlastico> {
  const estados = new Map<number, EstadoPlastico>();
  for (const p of plasticos) {
    if (p.esActivo) {
      estados.set(p.id, 'ACTIVA');
      continue;
    }
    const sucesor = plasticos.some(
      (h) => h.id !== p.id && (h.esActivo || h.reemplazaAId === p.id || (h.vigenteDesde !== null && (p.vigenteDesde === null || h.vigenteDesde > p.vigenteDesde))),
    );
    estados.set(p.id, sucesor ? 'REEMPLAZADA' : 'INACTIVA');
  }
  return estados;
}
