import { normalizarComercio } from '../notificaciones-correo/comercio.util';

/**
 * Lo que los formularios pre-llenan a partir del historial del usuario (plan V2, fase 4): el valor más habitual de cada campo.
 * Todo son funciones puras: el servicio solo trae los datos y este archivo decide.
 */

/**
 * El valor que más se repite. Los `valores` vienen de más reciente a más antiguo: en un empate gana el que apareció primero (el más
 * reciente). Ignora `null`/`undefined`. `null` si no hay ninguno.
 */
export function moda<T>(valores: ReadonlyArray<T | null | undefined>): T | null {
  const cuenta = new Map<T, { n: number; primero: number }>();
  valores.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const c = cuenta.get(v);
    if (c) c.n += 1;
    else cuenta.set(v, { n: 1, primero: i });
  });
  let mejor: T | null = null;
  let mejorN = 0;
  let mejorPrimero = Infinity;
  for (const [v, c] of cuenta) {
    if (c.n > mejorN || (c.n === mejorN && c.primero < mejorPrimero)) {
      mejor = v;
      mejorN = c.n;
      mejorPrimero = c.primero;
    }
  }
  return mejor;
}

export interface Uso<T> {
  id: T;
  /** Cuántas veces se usó. */
  n: number;
  /** Cuándo fue la última vez (ms desde epoch; 0 si no se sabe). */
  ultima: number;
}

/** Los ids de más a menos usados; a igual uso, el usado más recientemente primero. */
export function ordenarPorUso<T>(usos: ReadonlyArray<Uso<T>>): T[] {
  return [...usos].sort((a, b) => b.n - a.n || b.ultima - a.ultima).map((u) => u.id);
}

// ───────────────────────────── comercios habituales ─────────────────────────────

export interface CompraHistorica {
  concepto: string | null;
  /** Valor de la compra en COP. */
  valor?: number | null;
  numeroCuotas: number | null;
  tarjetaId: number | null;
  fecha: Date | null;
  /** Ids de las personas responsables de esa compra. */
  personas: number[];
}

export interface MovimientoHistorico {
  concepto: string | null;
  categoriaId: number | null;
  cuentaId: number | null;
  fecha: Date | null;
}

/** Lo que se sabe de un comercio por lo que ya se registró con él: sirve para pre-llenar el formulario al escribirlo. */
export interface ComercioHabitual {
  /** Como lo escribe el usuario normalmente («Didi Food»). */
  concepto: string;
  veces: number;
  /** `yyyy-MM-dd` de la última vez. */
  ultimaFecha: string | null;
  /** Cuotas con las que suele comprar ahí. */
  cuotas: number | null;
  /** Lo que costó la última compra a crédito ahí (una suscripción o un mercado casi igual cada vez). */
  ultimoValor: number | null;
  tarjetaId: number | null;
  categoriaId: number | null;
  cuentaId: number | null;
  personaId: number | null;
}

interface Registro {
  concepto: string;
  tiempo: number;
  valor: number | null;
  cuotas: number | null;
  tarjetaId: number | null;
  categoriaId: number | null;
  cuentaId: number | null;
  personas: number[];
}

const aTiempo = (f: Date | null): number => (f ? f.getTime() : 0);
const aDia = (t: number): string | null => (t > 0 ? new Date(t).toISOString().slice(0, 10) : null);

/**
 * Agrupa las compras a crédito y los egresos por comercio (con la forma canónica de `normalizarComercio`, así «DL*DIDI FOOD CO» y
 * «Didi Food» son el mismo) y resume cuál es su valor habitual en cada campo. De más a menos frecuente; a igual cantidad, el más
 * reciente primero. `filtro` (opcional) deja solo los que contienen ese texto, sin importar mayúsculas ni tildes.
 */
export function agruparComercios(
  compras: ReadonlyArray<CompraHistorica>,
  movimientos: ReadonlyArray<MovimientoHistorico>,
  limite = 300,
  filtro?: string,
): ComercioHabitual[] {
  const grupos = new Map<string, Registro[]>();
  const agregar = (clave: string, r: Registro): void => {
    const lista = grupos.get(clave);
    if (lista) lista.push(r);
    else grupos.set(clave, [r]);
  };
  for (const c of compras) {
    const clave = normalizarComercio(c.concepto);
    if (!clave || !c.concepto) continue;
    agregar(clave, { concepto: c.concepto.trim(), tiempo: aTiempo(c.fecha), valor: c.valor ?? null, cuotas: c.numeroCuotas, tarjetaId: c.tarjetaId, categoriaId: null, cuentaId: null, personas: c.personas });
  }
  for (const m of movimientos) {
    const clave = normalizarComercio(m.concepto);
    if (!clave || !m.concepto) continue;
    agregar(clave, { concepto: m.concepto.trim(), tiempo: aTiempo(m.fecha), valor: null, cuotas: null, tarjetaId: null, categoriaId: m.categoriaId, cuentaId: m.cuentaId, personas: [] });
  }

  const buscado = filtro ? normalizarParaBuscar(filtro) : '';
  const salida: ComercioHabitual[] = [];
  for (const [clave, registros] of grupos) {
    if (buscado && !normalizarParaBuscar(clave).includes(buscado) && !registros.some((r) => normalizarParaBuscar(r.concepto).includes(buscado))) continue;
    const recientes = [...registros].sort((a, b) => b.tiempo - a.tiempo);
    // una compra con varios responsables cuenta una vez por persona: gana la que más compras tiene
    const personasPorCompra = recientes.flatMap((r) => [...new Set(r.personas)]);
    salida.push({
      concepto: moda(recientes.map((r) => r.concepto)) as string,
      veces: registros.length,
      ultimaFecha: aDia(recientes[0].tiempo),
      cuotas: moda(recientes.map((r) => r.cuotas)),
      ultimoValor: recientes.find((r) => r.valor !== null && r.valor > 0)?.valor ?? null,
      tarjetaId: moda(recientes.map((r) => r.tarjetaId)),
      categoriaId: moda(recientes.map((r) => r.categoriaId)),
      cuentaId: moda(recientes.map((r) => r.cuentaId)),
      personaId: moda(personasPorCompra),
    });
  }
  return salida
    .sort((a, b) => b.veces - a.veces || (b.ultimaFecha ?? '').localeCompare(a.ultimaFecha ?? '') || a.concepto.localeCompare(b.concepto, 'es'))
    .slice(0, Math.max(1, limite));
}

/** Para comparar texto escrito por una persona: minúsculas, sin tildes y sin signos. */
export function normalizarParaBuscar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
