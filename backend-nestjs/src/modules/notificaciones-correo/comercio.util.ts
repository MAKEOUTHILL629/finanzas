/**
 * Normalización y comparación de nombres de comercio. Funciones puras: sin BD ni Nest.
 *
 * El banco reporta el comercio tal como lo cobra la pasarela ("DL*DIDI FOOD CO", "DLO*DIDI FOOD CO PAY",
 * "DIDI FOOD*DL", "RAPPI COLOMBIA*DL"…), mientras que el usuario registra sus compras con su propio nombre
 * ("DIDI FOODS", "PIZZAS DIDI"). Para reconocer «el mismo comercio» se reducen ambos a una forma canónica.
 */

const sinTildes = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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

export interface ComercioYTags {
  comercioCanonico: string | null;
  tags: string[];
}

/**
 * Normaliza un tag individual a formato slug con '#' (ej. "DiDi Food" -> "#didi-food").
 */
export function normalizarTagSlug(raw: string | null | undefined): string {
  if (!raw) return '';
  const limpio = sinTildes(raw)
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return limpio ? `#${limpio}` : '';
}

/**
 * Normaliza una lista de tags: separa por comas si vienen juntos, antepone '#', convierte a minúsculas y elimina duplicados.
 */
export function normalizarTags(tags: ReadonlyArray<string> | undefined | null): string[] {
  if (!tags || tags.length === 0) return [];
  const unicos = new Set<string>();
  for (const item of tags) {
    if (typeof item !== 'string') continue;
    for (const parte of item.split(',')) {
      const slug = normalizarTagSlug(parte);
      if (slug) unicos.add(slug);
    }
  }
  return [...unicos];
}

/**
 * Inferencia de comercio canónico + tags (Fase 2). El orden importa: las marcas paraguas se
 * desambiguan primero (DiDi Food ≠ DiDi Rides, Rappi Pro ≠ Rappi, Uber Eats ≠ Uber).
 */
export function inferirComercioYTags(descripcionRaw: string | null | undefined): ComercioYTags {
  const t = sinTildes(descripcionRaw ?? '').toLowerCase();
  if (!t.trim()) return { comercioCanonico: null, tags: [] };
  const R = (re: RegExp, comercioCanonico: string | null, tags: string[]): ComercioYTags | null =>
    re.test(t) ? { comercioCanonico, tags } : null;
  const encontrado =
    R(/didi\s*\*?\s*food|didi\s+restaurantes/, 'DiDi Food', ['#domicilios', '#didi-food', '#comida']) ??
    R(/didi(?!\s*\*?\s*food)|didi\s*rides|didi\s*mobility/, 'DiDi Rides', ['#transporte', '#didi-rides', '#movilidad']) ??
    R(/rappi\s*prime|rappi\s*pro/, 'Rappi Pro', ['#suscripciones', '#rappi']) ??
    R(/rappi/, 'Rappi', ['#domicilios', '#rappi', '#comida']) ??
    R(/uber\s*eats/, 'Uber Eats', ['#domicilios', '#uber-eats', '#comida']) ??
    R(/uber|cabify|picap|indriver|beat\b/, null, ['#transporte', '#movilidad']) ??
    R(/frisby|kfc|subway|sandwich\s*gourmet|mcdonalds|mc\s*donald|el\s*corral|burger\s*king|dominos|papa\s*john/, null, ['#comida', '#restaurantes']) ??
    R(/bershka/, 'Bershka', ['#ropa', '#bershka', '#moda']) ??
    R(/koaj|permis/, 'Koaj', ['#ropa', '#koaj', '#moda']) ??
    R(/zara|pull\s*&\s*bear|stradivarius|mattelsa|gef|punto\s*blanco|h&m|hym\b|falabella|arturo\s*calle/, null, ['#ropa', '#moda']) ??
    R(/avianca|latam|wingo|jetsmart|satena|easyfly/, null, ['#viajes', '#turismo', '#vuelos']) ??
    R(/airbnb|booking|despegar|hotel|glamping|hostal/, null, ['#viajes', '#turismo', '#hospedaje']) ??
    R(/peaje/, null, ['#viajes', '#transporte', '#peajes']) ??
    R(/netflix|spotify|youtube\s*premium|hbo|max\b|disney|apple\s*(tv|music|icloud)|icloud|chatgpt|openai|claude|gemini|amazon\s*prime|prime\s*video/, null, ['#suscripciones']) ??
    R(/codensa|enel|epm|agua|alcantarillado|gas\s*natural|vanti|claro|movistar|tigo|etb|internet|fibra/, null, ['#servicios', '#hogar']) ??
    R(/exito|carulla|jumbo|olimpica|d1\b|ara\b|mercado|crepes|homecenter|sodimac|ikea/, null, ['#mercado', '#hogar']);
  if (encontrado) return encontrado;
  const legible = nombreLegibleComercio(descripcionRaw);
  return { comercioCanonico: legible || null, tags: [] };
}

/** Ventana de un clúster de viajes: [inicio, fin] a partir de las fechas ancla (vuelos/hoteles). */
export function ventanasDeViaje(fechasAncla: Date[]): Array<{ desde: Date; hasta: Date }> {
  const ordenadas = [...fechasAncla].sort((a, b) => a.getTime() - b.getTime());
  const ventanas: Array<{ desde: Date; hasta: Date }> = [];
  const DIA = 86_400_000;
  for (const f of ordenadas) {
    const ultima = ventanas[ventanas.length - 1];
    if (ultima && f.getTime() - ultima.hasta.getTime() <= 10 * DIA) {
      if (f.getTime() > ultima.hasta.getTime()) ultima.hasta = new Date(f.getTime());
    } else {
      ventanas.push({ desde: new Date(f.getTime()), hasta: new Date(f.getTime()) });
    }
  }
  return ventanas.map((v) => ({ desde: new Date(v.desde.getTime() - DIA), hasta: new Date(v.hasta.getTime() + 3 * DIA) }));
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
