/**
 * Parser determinista (sin IA) de consultas en español para «Pregúntale a tu App» (Fase 2).
 * Extrae tags, comercios canónicos y rango de fechas de frases como
 * «¿cuánto he gastado en domicilios en Rappi y Didi este año?».
 */
export interface ConsultaParseada {
  tags: string[];
  comercios: string[];
  desde: Date | null;
  hasta: Date | null;
  textoPeriodo: string | null;
}

const plano = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const REGLAS_TAGS: Array<{ re: RegExp; tags: string[]; comercios?: string[] }> = [
  { re: /domicilios?|delivery|comida a domicilio/, tags: ['#domicilios'] },
  { re: /\brappi\b/, tags: ['#rappi'], comercios: ['Rappi', 'Rappi Pro'] },
  { re: /didi\s*food/, tags: ['#didi-food'], comercios: ['DiDi Food'] },
  { re: /\bdidi\b/, tags: ['#didi-food', '#didi-rides'], comercios: ['DiDi Food', 'DiDi Rides'] },
  { re: /uber\s*eats/, tags: ['#uber-eats'], comercios: ['Uber Eats'] },
  { re: /transporte|movilidad|taxis?|uber|cabify/, tags: ['#transporte', '#movilidad'] },
  { re: /bershka/, tags: ['#bershka'], comercios: ['Bershka'] },
  { re: /koaj/, tags: ['#koaj'], comercios: ['Koaj'] },
  { re: /ropa|moda|vestir|zara/, tags: ['#ropa', '#moda'] },
  { re: /viajes?|turismo|vacaciones|vuelos?|hoteles?/, tags: ['#viajes'] },
  { re: /suscripciones|suscripcion/, tags: ['#suscripciones'] },
  { re: /restaurantes?|comida|almuerzos?|comer/, tags: ['#comida', '#restaurantes', '#domicilios'] },
  { re: /mercado|supermercado|super\b/, tags: ['#mercado'] },
  { re: /servicios|recibos|luz|agua|internet/, tags: ['#servicios'] },
];

function rangoPeriodo(t: string, hoy: Date): { desde: Date; hasta: Date; texto: string } | null {
  const anio = /en (20\d{2})/.exec(t);
  if (anio) return { desde: new Date(Date.UTC(Number(anio[1]), 0, 1)), hasta: new Date(Date.UTC(Number(anio[1]), 11, 31, 23, 59, 59)), texto: `en ${anio[1]}` };
  if (/este ano/.test(t)) return { desde: new Date(Date.UTC(hoy.getUTCFullYear(), 0, 1)), hasta: hoy, texto: 'este año' };
  if (/este mes/.test(t)) return { desde: new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1)), hasta: hoy, texto: 'este mes' };
  const ultimos = /ultimos? (\d+) meses?/.exec(t);
  if (ultimos) {
    const desde = new Date(hoy); desde.setUTCMonth(desde.getUTCMonth() - Number(ultimos[1]));
    return { desde, hasta: hoy, texto: `últimos ${ultimos[1]} meses` };
  }
  if (/el mes pasado|mes anterior/.test(t)) {
    return { desde: new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)), hasta: new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0, 23, 59, 59)), texto: 'el mes pasado' };
  }
  if (/hoy/.test(t)) return { desde: new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate())), hasta: hoy, texto: 'hoy' };
  return null;
}

export function parsearConsulta(q: string, hoy: Date = new Date()): ConsultaParseada {
  const t = plano(q ?? '');
  const tags = new Set<string>();
  const comercios = new Set<string>();
  for (const r of REGLAS_TAGS) {
    if (r.re.test(t)) {
      r.tags.forEach((x) => tags.add(x));
      (r.comercios ?? []).forEach((x) => comercios.add(x));
    }
  }
  // Hashtags escritos tal cual: #domicilios
  for (const m of t.matchAll(/#([a-z0-9-]+)/g)) tags.add(`#${m[1]}`);
  const periodo = rangoPeriodo(t, hoy);
  return { tags: [...tags], comercios: [...comercios], desde: periodo?.desde ?? null, hasta: periodo?.hasta ?? null, textoPeriodo: periodo?.texto ?? null };
}
