/**
 * Reconoce a qué persona registrada corresponde la contraparte de un movimiento ("ALICIA BUITRAGO",
 * "Carlos Andres Hernandez Giraldo (Llave: 3108892985)"). Funciones puras: sin BD ni Nest.
 */

const sinTildes = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);

export interface PersonaCandidata {
  id: bigint;
  nombre: string | null;
  numero_celular?: string | null;
}

/** Palabras significativas de un nombre, sin tildes ni mayúsculas. */
export function tokensNombre(texto: string | null | undefined): string[] {
  if (!texto) return [];
  return sinTildes(texto)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Nombre de la contraparte a partir del «comercio» del correo. Devuelve `null` si en realidad es un número de
 * cuenta/llave ("Cuenta *3195974366", "Llave: 304…", "Destino: *1550"), que no identifica a nadie.
 */
export function nombreContraparte(comercio: string | null | undefined): string | null {
  if (!comercio) return null;
  const limpio = comercio.replace(/\(\s*llave:[^)]*\)/i, '').replace(/\s+/g, ' ').trim();
  if (!limpio || /^(cuenta|llave|destino|producto|cta)\b/i.test(limpio)) return null;
  return tokensNombre(limpio).length >= 2 ? limpio : null;
}

/** Dígitos de una llave de celular ("3044487126" o "@plata3118895702" → "3118895702"). */
export function celularDeLlave(llave: string | null | undefined): string | null {
  const digitos = (llave ?? '').replace(/\D/g, '');
  return digitos.length >= 10 ? digitos.slice(-10) : null;
}

/**
 * Persona que corresponde al nombre (y, si se conoce, al celular de la llave). Solo se resuelve si es inequívoca:
 * un nombre debe estar contenido en el otro con al menos 2 palabras, y no puede haber otra persona igual de buena.
 */
export function encontrarPersona<T extends PersonaCandidata>(
  personas: T[],
  nombre: string | null | undefined,
  llave?: string | null,
): T | null {
  const celular = celularDeLlave(llave);
  if (celular) {
    const porCelular = personas.filter((p) => (p.numero_celular ?? '').replace(/\D/g, '').slice(-10) === celular);
    if (porCelular.length === 1) return porCelular[0];
  }

  const buscado = new Set(tokensNombre(nombre));
  if (buscado.size < 2) return null;

  let mejor: T[] = [];
  let mejorPuntaje = 0;
  for (const p of personas) {
    const propios = new Set(tokensNombre(p.nombre));
    if (propios.size === 0) continue;
    const comunes = [...buscado].filter((t) => propios.has(t)).length;
    const contenido = comunes === buscado.size || comunes === propios.size;
    if (comunes < 2 || !contenido) continue;
    if (comunes > mejorPuntaje) {
      mejorPuntaje = comunes;
      mejor = [p];
    } else if (comunes === mejorPuntaje) {
      mejor.push(p);
    }
  }
  return mejor.length === 1 ? mejor[0] : null;
}
