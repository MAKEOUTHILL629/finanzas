import { Decimal } from '../../config/decimal.config';
import { mismoComercio, similitudComercio } from './comercio.util';
import { CompraSnap, conceptoNormalizado, ResponsableSnap, SnapshotCorreos } from './snapshot-correos';

/**
 * «Plantilla» de una compra de tarjeta de crédito nueva: cuotas, responsables y porcentajes que el usuario YA ha usado con
 * el mismo comercio (o uno muy parecido). Se deduce del historial: nada se configura a mano y cada corrección del
 * usuario sobre una compra se refleja en la siguiente.
 */

export interface PlantillaCompra {
  numeroCuotas: number;
  interes: Decimal | null;
  /** Concepto que el usuario suele escribir para este comercio, solo si es claramente dominante. */
  concepto: string | null;
  responsables: ResponsableSnap[];
  /** Compras comparadas y qué fracción (ponderada) comparte el patrón elegido. */
  muestras: number;
  confianza: number;
  origen: 'historial' | 'concepto_similar';
}

const MAX_MUESTRAS = 12;
const MIN_MUESTRAS = 2;
const MIN_CONFIANZA = 0.5;
const UMBRAL_HISTORIAL = 0.6;
const UMBRAL_CONCEPTO = 0.8;

const claveResponsables = (rs: ResponsableSnap[]): string =>
  rs
    .map((r) => `${r.personaId}:${r.porcentaje.toFixed(2)}:${r.cuotas ?? ''}`)
    .sort()
    .join(',');

const clavePatron = (c: CompraSnap): string => `${c.cuotas}|${claveResponsables(c.responsables)}`;

/** Compras de correos YA revisados cuyo comercio se parece al buscado, más recientes primero. */
function comprasDelHistorial(snap: SnapshotCorreos, comercioNorm: string): CompraSnap[] {
  const porId = new Map(snap.compras.map((c) => [c.id, c]));
  const vistas = new Set<bigint>();
  const resultado: CompraSnap[] = [];
  for (const n of snap.notificaciones) {
    // Solo se aprende de lo revisado: una compra creada sin plantilla y sin tocar (PENDIENTE) no es una preferencia.
    if (n.compraId === null || n.estado !== 'CONCILIADO' || !n.comercioNorm || vistas.has(n.compraId)) continue;
    if (!mismoComercio(n.comercioNorm, comercioNorm, UMBRAL_HISTORIAL)) continue;
    const compra = porId.get(n.compraId);
    if (!compra) continue;
    vistas.add(n.compraId);
    resultado.push(compra);
  }
  return resultado;
}

/** Compras que el usuario registró a mano con un concepto parecido al comercio (cuando aún no hay historial de correos). */
function comprasPorConcepto(snap: SnapshotCorreos, comercioNorm: string, yaIncluidas: Set<bigint>): CompraSnap[] {
  // Las compras que la app creó desde un correo y nadie ha revisado (PENDIENTE) tampoco son una preferencia del usuario.
  const sinRevisar = new Set(snap.notificaciones.filter((n) => n.estado === 'PENDIENTE' && n.compraId !== null).map((n) => n.compraId));
  return snap.compras.filter(
    (c) => !yaIncluidas.has(c.id) && !sinRevisar.has(c.id) && similitudComercio(conceptoNormalizado(c), comercioNorm) >= UMBRAL_CONCEPTO,
  );
}

export function elegirPlantilla(snap: SnapshotCorreos, comercioNorm: string): PlantillaCompra | null {
  if (!comercioNorm) return null;

  let candidatas = comprasDelHistorial(snap, comercioNorm);
  let origen: PlantillaCompra['origen'] = 'historial';
  if (candidatas.length < MIN_MUESTRAS) {
    candidatas = [...candidatas, ...comprasPorConcepto(snap, comercioNorm, new Set(candidatas.map((c) => c.id)))];
    origen = 'concepto_similar';
  }
  candidatas = candidatas.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : Number(b.id - a.id))).slice(0, MAX_MUESTRAS);
  if (candidatas.length < MIN_MUESTRAS) return null;

  // Las 5 más recientes pesan el doble: si el usuario cambió de costumbre, la plantilla lo sigue.
  const pesos = new Map<string, { peso: number; compras: CompraSnap[] }>();
  let total = 0;
  candidatas.forEach((c, i) => {
    const peso = i < 5 ? 2 : 1;
    total += peso;
    const clave = clavePatron(c);
    const g = pesos.get(clave) ?? { peso: 0, compras: [] };
    g.peso += peso;
    g.compras.push(c);
    pesos.set(clave, g);
  });
  const dominante = [...pesos.values()].sort((a, b) => b.peso - a.peso)[0];
  const confianza = dominante.peso / total;
  if (confianza < MIN_CONFIANZA) return null;

  const reciente = dominante.compras[0]; // ya vienen de más reciente a más antigua
  const conceptos = new Map<string, { n: number; original: string }>();
  for (const c of dominante.compras) {
    const k = c.concepto.trim().toLowerCase();
    const e = conceptos.get(k) ?? { n: 0, original: c.concepto.trim() };
    e.n += 1;
    conceptos.set(k, e);
  }
  const topConcepto = [...conceptos.values()].sort((a, b) => b.n - a.n)[0];
  const concepto = topConcepto && topConcepto.n / dominante.compras.length >= 0.5 && topConcepto.original ? topConcepto.original : null;

  return {
    numeroCuotas: reciente.cuotas,
    interes: reciente.interes,
    concepto,
    responsables: reciente.responsables.map((r) => ({ ...r })),
    muestras: candidatas.length,
    confianza: Math.round(confianza * 100) / 100,
    origen,
  };
}
