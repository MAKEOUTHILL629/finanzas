/**
 * Lógica PURA de los plásticos de una tarjeta de crédito (sin base de datos): qué plástico estaba vigente en una fecha,
 * cómo se serializa la lista de últimos 4 dígitos y cómo se calcula el cierre del plástico anterior al reemplazarlo.
 *
 * Una «tarjeta» (`Tarjetas`) es la línea de crédito; cada reposición (vencimiento, pérdida, robo…) es un plástico nuevo
 * con otros últimos 4 dígitos. Las compras siguen colgando de la línea; el plástico solo dice con cuál se pagó.
 */

export const MOTIVOS_REEMPLAZO = ['VENCIMIENTO', 'PERDIDA', 'ROBO', 'DETERIORO', 'FRAUDE', 'CAMBIO_PRODUCTO', 'OTRO'] as const;
export type MotivoReemplazo = (typeof MOTIVOS_REEMPLAZO)[number];

export interface PlasticoBase {
  id: bigint | number;
  ultimos4: string;
  esActivo: boolean;
  vigenteDesde: Date | null;
  vigenteHasta: Date | null;
}

export interface PlasticoDeFecha<T extends PlasticoBase> {
  plastico: T;
  /** `true` cuando no se guardó en la compra: se dedujo de las fechas de vigencia (o del único plástico conocido). */
  inferido: boolean;
}

/** Grupos de 4 dígitos de un texto ("1927, 9587" → ["1927","9587"]), sin repetir y en orden. */
export function tokensUltimos4(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const vistos = new Set<string>();
  for (const m of texto.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) vistos.add(m[1]);
  return [...vistos];
}

/**
 * Valor para `Tarjetas.ultimos_4_digitos`: el plástico activo primero y luego los demás del más reciente al más antiguo.
 * El parser de correos solo necesita que estén TODOS (también los archivados: llegan avisos viejos al reprocesar).
 */
export function cadenaUltimos4(plasticos: Array<Pick<PlasticoBase, 'ultimos4' | 'esActivo'> & { orden?: number }>): string {
  const ordenados = [...plasticos].sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || (b.orden ?? 0) - (a.orden ?? 0));
  return ordenados.map((p) => p.ultimos4).join(',');
}

const dia = (d: Date | null): number => (d ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : Number.NEGATIVE_INFINITY);

/**
 * Plástico con el que se pagó una compra hecha en `fecha`, deducido de las vigencias:
 *  1. el de `vigente_desde` más reciente que no sea posterior a la fecha (el de inicio desconocido se considera el más antiguo);
 *  2. si la fecha es anterior al inicio de todos, el más antiguo;
 *  3. sin plásticos, `null`.
 * Con un solo plástico siempre es ese. Es una deducción, no un dato: la compra puede tenerlo guardado y entonces manda lo guardado.
 */
export function plasticoParaFecha<T extends PlasticoBase>(plasticos: T[], fecha: Date | null): PlasticoDeFecha<T> | null {
  if (plasticos.length === 0) return null;
  if (plasticos.length === 1) return { plastico: plasticos[0], inferido: true };
  const ordenados = [...plasticos].sort((a, b) => dia(a.vigenteDesde) - dia(b.vigenteDesde) || Number(a.id) - Number(b.id));
  if (!fecha) {
    const activo = ordenados.find((p) => p.esActivo) ?? ordenados[ordenados.length - 1];
    return { plastico: activo, inferido: true };
  }
  const t = dia(fecha);
  const vigentes = ordenados.filter((p) => dia(p.vigenteDesde) <= t);
  return { plastico: vigentes.length > 0 ? vigentes[vigentes.length - 1] : ordenados[0], inferido: true };
}

/** Un día antes (UTC), para cerrar el plástico anterior sin solaparse con el nuevo. */
export function diaAnterior(fecha: Date): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate() - 1));
}

/**
 * Fecha de cierre del plástico que se reemplaza: la víspera del plástico nuevo, pero nunca antes de su propio inicio
 * (un plástico que se reemplaza el mismo día que empezó queda de un solo día).
 */
export function cierreDelAnterior(desdeAnterior: Date | null, inicioNuevo: Date): Date {
  const victima = diaAnterior(inicioNuevo);
  return desdeAnterior && dia(desdeAnterior) > dia(victima) ? desdeAnterior : victima;
}

/** ¿El reemplazo empieza antes de que el plástico actual haya empezado? (no tiene sentido cronológico) */
export function reemplazoAnteriorAlInicio(desdeActual: Date | null, inicioNuevo: Date): boolean {
  return desdeActual !== null && dia(inicioNuevo) < dia(desdeActual);
}
