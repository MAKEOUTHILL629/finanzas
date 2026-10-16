/**
 * Normalización y comparación de nombres de comercio. Funciones puras: sin BD ni Nest.
 *
 * El banco reporta el comercio tal como lo cobra la pasarela ("DL*DIDI FOOD CO", "DLO*DIDI FOOD CO PAY",
 * "DIDI FOOD*DL", "RAPPI COLOMBIA*DL"…), mientras que el usuario registra sus compras con su propio nombre
 * ("DIDI FOODS", "PIZZAS DIDI"). Para reconocer «el mismo comercio» se reducen ambos a una forma canónica.
 */

const sinTildes = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Prefijos/sufijos de pasarela de pago que no forman parte del nombre del comercio. */
const PASARELAS = new Set(['dl', 'dlo', 'payu', 'bold', 'pse', 'sq', 'tpaga', 'wompi', 'epayco', 'paypal']);

/** Palabras que no distinguen un comercio de otro. */
const GENERICAS = new Set([
  'co', 'col', 'colo', 'colombia', 'sas', 'sa', 's', 'a', 'ltda', 'pay', 'ph', 'cc', 'com', 'www', 'bv', 'usd', 'inc', 'srl',
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en',
]);

function tokenizar(texto: string): string[] {
  return sinTildes(texto)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !/^\d+$/.test(t) && !PASARELAS.has(t) && !GENERICAS.has(t))
    // plural simple: "foods" → "food", "restaurantes" → "restaurante"
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Forma canónica del comercio ("DL*DIDI FOOD CO" → "didi food"). Vacía si el texto no aporta nada. */
export function normalizarComercio(texto: string | null | undefined): string {
  if (!texto) return '';
  const tokens = tokenizar(texto);
  if (tokens.length > 0) return tokens.join(' ');
  // Todo eran palabras genéricas: se conserva lo alfanumérico para no perder la identidad del comercio.
  return sinTildes(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** La «marca» es el primer término significativo ("didi food" → "didi"). */
export function marcaDeComercio(normalizado: string): string {
  return normalizado.split(' ')[0] ?? '';
}

const jaccard = (a: string[], b: string[]): number => {
  const conjuntoA = new Set(a);
  const conjuntoB = new Set(b);
  const comunes = [...conjuntoA].filter((t) => conjuntoB.has(t)).length;
  const union = new Set([...conjuntoA, ...conjuntoB]).size;
  return union === 0 ? 0 : comunes / union;
};

/**
 * Parecido entre dos comercios YA normalizados, de 0 a 1:
 *  1.0  idénticos;  0.6 misma marca y uno de los dos no especifica ("didi" ~ "didi food");
 *  0.5–1.0 misma marca con distintos complementos ("didi food" ~ "didi ride" = 0.5);  < 0.5 marcas distintas.
 */
export function similitudComercio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(' ');
  const tb = b.split(' ');
  if (ta[0] === tb[0]) {
    const restoA = ta.slice(1);
    const restoB = tb.slice(1);
    if (restoA.length === 0 && restoB.length === 0) return 1;
    if (restoA.length === 0 || restoB.length === 0) return 0.6;
    return 0.5 + 0.5 * jaccard(restoA, restoB);
  }
  return jaccard(ta, tb) * 0.8;
}

/** ¿Los dos comercios son lo bastante parecidos para compartir historial? */
export function mismoComercio(a: string, b: string, umbral = 0.6): boolean {
  return similitudComercio(a, b) >= umbral;
}

/** Nombre presentable del comercio ("DL*DIDI FOOD CO" → "Didi Food"): sin pasarela ni palabras genéricas, con mayúscula inicial. */
export function nombreLegibleComercio(texto: string | null | undefined): string {
  if (!texto) return '';
  const tokens = sinTildes(texto)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !/^\d+$/.test(t) && !PASARELAS.has(t) && !GENERICAS.has(t));
  const base = tokens.length > 0 ? tokens : [texto.trim().toLowerCase()];
  return base.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
}
