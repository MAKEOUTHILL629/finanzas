import { Decimal } from '../../config/decimal.config';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';

export type ModoDivision = 'IGUAL' | 'PORCENTAJE' | 'MONTO';

export interface ParticipanteEntrada {
  personaId: number;
  monto?: number | string;
  porcentaje?: number | string;
}

export interface ParteCalculada {
  personaId: number;
  monto: Decimal;
  porcentaje: Decimal | null;
  /** La parte del propietario: queda registrada pero no genera deuda. */
  esPropio: boolean;
}

/**
 * Reparte un gasto entre personas.
 *  • IGUAL      — a partes iguales entre quienes se listan (incluido el propietario si se lista). Los centavos que sobran se
 *                 reparten de a uno desde el primero, de modo que la suma es EXACTAMENTE el total.
 *  • PORCENTAJE — cada quien un %; lo que no reparte (< 100 %) es del propietario. Si reparte el 100 %, el último absorbe el redondeo.
 *  • MONTO      — cada quien un monto fijo; lo que sobra del total es del propietario. No pueden sumar más que el total.
 */
export function calcularPartes(
  total: Decimal,
  modo: ModoDivision,
  participantes: ParticipanteEntrada[],
  miPersonaId: bigint | number | null,
): ParteCalculada[] {
  if (!total.greaterThan(0)) throw datosInvalidos({ montoTotal: ['montoTotal debe ser mayor a 0'] });
  if (participantes.length === 0) throw datosInvalidos({ participantes: ['Indica al menos una persona'] });
  const ids = participantes.map((p) => p.personaId);
  if (new Set(ids).size !== ids.length) throw datosInvalidos({ participantes: ['Una persona no puede aparecer dos veces'] });

  const esMia = (id: number) => miPersonaId !== null && BigInt(id) === BigInt(miPersonaId);
  const cts = (d: Decimal) => d.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  if (modo === 'IGUAL') {
    const n = participantes.length;
    const totalCts = cts(total);
    const base = totalCts.dividedToIntegerBy(n);
    const sobrante = totalCts.minus(base.times(n)).toNumber();
    return participantes.map((p, i) => ({
      personaId: p.personaId,
      monto: money(base.plus(i < sobrante ? 1 : 0).dividedBy(100)),
      porcentaje: null,
      esPropio: esMia(p.personaId),
    }));
  }

  if (modo === 'PORCENTAJE') {
    const pcts = participantes.map((p, i) => {
      const v = p.porcentaje === undefined || p.porcentaje === null ? null : toDecimal(p.porcentaje);
      if (!v || !v.greaterThan(0) || v.greaterThan(100)) {
        throw datosInvalidos({ [`participantes[${i}].porcentaje`]: ['El porcentaje debe estar entre 0 y 100'] });
      }
      return v;
    });
    const suma = pcts.reduce((acc, v) => acc.plus(v), new Decimal(0));
    if (suma.greaterThan(100)) throw datosInvalidos({ participantes: [`Los porcentajes suman ${suma.toString()} %: no pueden superar 100 %`] });
    const montos = pcts.map((v) => money(total.times(v).dividedBy(100)));
    if (suma.equals(100)) {
      const dif = total.minus(montos.reduce((acc, m) => acc.plus(m), new Decimal(0)));
      montos[montos.length - 1] = money(montos[montos.length - 1].plus(dif));
    }
    return participantes.map((p, i) => ({ personaId: p.personaId, monto: montos[i], porcentaje: pcts[i], esPropio: esMia(p.personaId) }));
  }

  const montos = participantes.map((p, i) => {
    const v = p.monto === undefined || p.monto === null ? null : money(toDecimal(p.monto));
    if (!v || !v.greaterThan(0)) throw datosInvalidos({ [`participantes[${i}].monto`]: ['El monto debe ser mayor a 0'] });
    return v;
  });
  const suma = montos.reduce((acc, m) => acc.plus(m), new Decimal(0));
  if (suma.greaterThan(total)) throw datosInvalidos({ participantes: [`Los montos suman ${suma.toString()} y superan el total ${total.toString()}`] });
  return participantes.map((p, i) => ({
    personaId: p.personaId,
    monto: montos[i],
    porcentaje: money(montos[i].times(100).dividedBy(total)),
    esPropio: esMia(p.personaId),
  }));
}
