import { Decimal } from '../../config/decimal.config';
import {
  calcularAmortizacionFrancesa,
  cuotaFrancesa,
  tasaEfectivaAnual,
  tasaImplicitaDeCuota,
  tasaMensualDesdeEfectivaAnual,
} from '../../common/utils/amortizacion-francesa.util';
import { CuotaCalculada } from '../../common/utils/calculadora-amortizacion.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { money, rate, sumDecimals } from '../../common/utils/decimal.util';

/**
 * Cálculos puros del refinanciamiento / unificación de deuda de una tarjeta (plan V2, fase 5): la simulación que el asesor del
 * banco da por teléfono (cuántas cuotas, qué tasa, cuánto de cuota) y cómo se reparte la nueva obligación entre las personas.
 */

/** Una compra a crédito que se podría unificar, con lo que le falta por pagar. */
export interface CompraUnificable {
  id: number;
  /** Capital que todavía no se ha pagado (cuotas pendientes del periodo en curso en adelante). */
  saldoCapital: Decimal;
  /** Lo que falta por pagar contando intereses (suma de las cuotas pendientes). */
  restantePorPagar: Decimal;
  /** Lo que cuesta la próxima cuota de esta compra. */
  cuotaProxima: Decimal;
  responsables: Array<{ personaId: number; porcentaje: Decimal }>;
}

export interface TotalesSeleccion {
  saldo: Decimal;
  cuotaActualCombinada: Decimal;
  restantePorPagar: Decimal;
}

export function totalesDeSeleccion(compras: ReadonlyArray<CompraUnificable>): TotalesSeleccion {
  return {
    saldo: money(sumDecimals(compras.map((c) => c.saldoCapital))),
    cuotaActualCombinada: money(sumDecimals(compras.map((c) => c.cuotaProxima))),
    restantePorPagar: money(sumDecimals(compras.map((c) => c.restantePorPagar))),
  };
}

export interface EntradaSimulacion {
  saldo: Decimal;
  numeroCuotas: number;
  /** Tasa MENSUAL (M.V.) en %: o esta o la efectiva anual (o ninguna, si el asesor solo dio la cuota). */
  tasaMensualPct?: Decimal | null;
  /** Tasa EFECTIVA ANUAL (E.A.) en %: se convierte a mensual. */
  tasaEfectivaAnualPct?: Decimal | null;
  /**
   * La cuota exacta que dio el banco (con seguros o ajustes). Manda sobre la calculada: la tabla se arma con la tasa REAL que esa
   * cuota implica (puede ser mayor que la anunciada porque incluye seguros y cargos).
   */
  cuotaPactada?: Decimal | null;
  /** Lo que se paga hoy por mes con esas compras (para comparar). */
  cuotaActualCombinada: Decimal;
  /** Lo que faltaría pagar sin refinanciar (para el costo total). */
  restantePorPagar: Decimal;
  fechaInicio: Date;
  diaCorteTarjeta?: number | null;
  hoy: Date;
}

export interface ResultadoSimulacion {
  saldo: Decimal;
  numeroCuotas: number;
  /** Tasa con la que se arma la tabla: la informada o, con una cuota pactada, la que esa cuota implica. */
  tasaMensualPct: Decimal;
  tasaEfectivaAnualPct: Decimal;
  /** Lo que dijo el asesor (mensual); `null` si solo dio la cuota. */
  tasaInformadaPct: Decimal | null;
  /** Cuota que sale de la fórmula con la tasa informada (`null` si no se informó tasa). */
  cuotaCalculada: Decimal | null;
  /** Cuota con la que de verdad se arma la tabla (la pactada, si la hay). */
  cuotaUsada: Decimal;
  cuotaPactada: Decimal | null;
  totalAPagar: Decimal;
  interesTotal: Decimal;
  cuotaActualCombinada: Decimal;
  /** Cuota actual − nueva cuota: lo que se libera cada mes (negativo si la cuota sube). */
  diferenciaMensual: Decimal;
  restantePorPagar: Decimal;
  /** Lo que faltaba pagar − lo que se pagará: el ahorro (o sobrecosto, si es negativo) de todo el plazo. */
  diferenciaTotal: Decimal;
  cuotas: CuotaCalculada[];
}

/** Valida y resuelve la tasa mensual a partir de la mensual o de la efectiva anual (exactamente una). */
export function resolverTasaMensual(mensualPct?: Decimal | null, efectivaAnualPct?: Decimal | null): Decimal {
  const hayMensual = mensualPct !== null && mensualPct !== undefined;
  const hayAnual = efectivaAnualPct !== null && efectivaAnualPct !== undefined;
  if (hayMensual && hayAnual) throw datosInvalidos({ tasa: ['Indica la tasa mensual o la efectiva anual, no las dos'] });
  if (!hayMensual && !hayAnual) throw datosInvalidos({ tasa: ['Indica la tasa mensual o la efectiva anual'] });
  const tasa = hayMensual ? (mensualPct as Decimal) : tasaMensualDesdeEfectivaAnual(efectivaAnualPct as Decimal);
  if (tasa.isNegative() || tasa.greaterThan(20)) throw datosInvalidos({ tasa: ['La tasa mensual debe estar entre 0 y 20 %'] });
  return rate(tasa);
}

/** Lo que el asesor te diría: cuota, costo total y diferencia con lo que pagas hoy, más la tabla completa. */
export function simularRefinanciamiento(e: EntradaSimulacion): ResultadoSimulacion {
  if (!e.saldo.greaterThan(0)) throw datosInvalidos({ saldo: ['No hay saldo pendiente para unificar'] });
  if (!Number.isInteger(e.numeroCuotas) || e.numeroCuotas < 1 || e.numeroCuotas > 120) {
    throw datosInvalidos({ numeroCuotas: ['El número de cuotas debe ser un entero entre 1 y 120'] });
  }
  const pactada = e.cuotaPactada && e.cuotaPactada.greaterThan(0) ? money(e.cuotaPactada) : null;
  const dioTasa = (e.tasaMensualPct ?? null) !== null || (e.tasaEfectivaAnualPct ?? null) !== null;
  const tasaInformadaPct = dioTasa ? resolverTasaMensual(e.tasaMensualPct, e.tasaEfectivaAnualPct) : null;
  if (!dioTasa && !pactada) throw datosInvalidos({ tasa: ['Indica la tasa (mensual o efectiva anual) o la cuota que dio el banco'] });

  // Con la cuota del banco, la tasa de la tabla es la que esa cuota implica (incluye seguros y cargos); sin ella, la informada.
  let tasaMensualPct = tasaInformadaPct as Decimal;
  if (pactada) {
    const implicita = tasaImplicitaDeCuota(e.saldo, e.numeroCuotas, pactada);
    if (implicita === null) {
      throw datosInvalidos({
        cuotaMensual: [
          pactada.mul(e.numeroCuotas).lessThan(e.saldo)
            ? `Con esa cuota y ${e.numeroCuotas} cuotas no se alcanza a pagar el saldo (${money(pactada.mul(e.numeroCuotas)).toString()} < ${money(e.saldo).toString()})`
            : 'Esa cuota implica una tasa mayor a 20 % mensual: revisa el valor',
        ],
      });
    }
    tasaMensualPct = rate(implicita);
  }

  let cuotas: CuotaCalculada[];
  try {
    cuotas = calcularAmortizacionFrancesa(e.saldo, tasaMensualPct, e.numeroCuotas, e.fechaInicio, e.diaCorteTarjeta, e.hoy, pactada);
  } catch (error) {
    throw datosInvalidos({ cuotaMensual: [error instanceof Error ? error.message : 'No se pudo armar la tabla de cuotas'] });
  }
  const totalAPagar = money(sumDecimals(cuotas.map((c) => c.pagoTotal)));
  const cuotaCalculada = tasaInformadaPct ? money(cuotaFrancesa(e.saldo, tasaInformadaPct, e.numeroCuotas)) : null;
  const cuotaUsada = pactada ?? (cuotaCalculada as Decimal);
  return {
    saldo: money(e.saldo),
    numeroCuotas: e.numeroCuotas,
    tasaMensualPct,
    tasaEfectivaAnualPct: money(tasaEfectivaAnual(tasaMensualPct)),
    tasaInformadaPct,
    cuotaCalculada,
    cuotaUsada,
    cuotaPactada: pactada,
    totalAPagar,
    interesTotal: money(totalAPagar.minus(e.saldo)),
    cuotaActualCombinada: money(e.cuotaActualCombinada),
    diferenciaMensual: money(e.cuotaActualCombinada.minus(cuotaUsada)),
    restantePorPagar: money(e.restantePorPagar),
    diferenciaTotal: money(e.restantePorPagar.minus(totalAPagar)),
    cuotas,
  };
}

export interface ResumenBarrido {
  /** Suma de saldos de capital en BD de las compras barridas al corte. */
  capitalTeorico: Decimal;
  /** Valor exacto que fijó el banco ($X). */
  montoUnificadoBanco: Decimal;
  /** X − capital teórico: intereses corrientes, seguros o cuotas de manejo capitalizados por el banco. */
  ajusteBanco: Decimal;
  cantidadCompras: number;
}

/** Compara el capital teórico detectado en BD contra el valor $X que fijó el banco al barrer por fecha de corte. */
export function resumenBarrido(compras: ReadonlyArray<CompraUnificable>, montoUnificadoBanco: Decimal): ResumenBarrido {
  const capitalTeorico = money(sumDecimals(compras.map((c) => c.saldoCapital)));
  const monto = money(montoUnificadoBanco);
  if (!monto.greaterThan(0)) throw datosInvalidos({ montoUnificadoBanco: ['El valor unificado por el banco debe ser mayor que cero'] });
  return { capitalTeorico, montoUnificadoBanco: monto, ajusteBanco: money(monto.minus(capitalTeorico)), cantidadCompras: compras.length };
}

export interface ResponsableDeMaestra {
  personaId: number;
  /** % de la nueva obligación (2 decimales). */
  porcentaje: Decimal;
  /** Su parte del saldo unificado. */
  monto: Decimal;
}

/**
 * Quién paga la obligación nueva: cada persona conserva su parte de lo que unificó, en proporción al capital que se llevó cada
 * compra (una persona con el 100 % de una compra de $1 M y otra con el 50 % de una de $3 M → 40 % / 60 %). Lo que no tiene
 * responsable es tuyo y no genera cargo a nadie. Los porcentajes suman a lo sumo 100.
 */
export function responsablesDeLaMaestra(compras: ReadonlyArray<CompraUnificable>, saldoTotal: Decimal): ResponsableDeMaestra[] {
  if (!saldoTotal.greaterThan(0)) return [];
  const porPersona = new Map<number, Decimal>();
  for (const c of compras) {
    for (const r of c.responsables) {
      const parte = c.saldoCapital.mul(r.porcentaje).div(100);
      porPersona.set(r.personaId, (porPersona.get(r.personaId) ?? new Decimal(0)).plus(parte));
    }
  }
  const lista = [...porPersona.entries()]
    .map(([personaId, parte]) => ({ personaId, porcentaje: parte.div(saldoTotal).mul(100).toDecimalPlaces(2) }))
    .filter((r) => r.porcentaje.greaterThan(0))
    .sort((a, b) => b.porcentaje.comparedTo(a.porcentaje) || a.personaId - b.personaId);
  // el redondeo no puede pasar de 100: el exceso (centésimas) se le quita a quien más tiene
  const exceso = sumDecimals(lista.map((r) => r.porcentaje)).minus(100);
  if (exceso.greaterThan(0) && lista.length > 0) lista[0].porcentaje = lista[0].porcentaje.minus(exceso);
  return lista.map((r) => ({ personaId: r.personaId, porcentaje: r.porcentaje, monto: money(saldoTotal.mul(r.porcentaje).div(100)) }));
}
