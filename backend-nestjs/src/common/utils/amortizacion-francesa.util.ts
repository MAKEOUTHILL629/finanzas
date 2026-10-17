import { Decimal } from '../../config/decimal.config';
import { CuotaCalculada, calcularFechaPrimeraCuota } from './calculadora-amortizacion.util';
import { addMonths, endOfMonth, isBefore, periodoOf, todayLocal } from './date.util';
import { money, normalizeZero } from './decimal.util';

/**
 * Amortización FRANCESA (cuota fija), la que usa el banco en un refinanciamiento: cada mes se paga lo mismo y la parte de interés
 * baja mientras la de capital sube.
 *
 *     C = P · i · (1 + i)ⁿ / ((1 + i)ⁿ − 1)        (i = tasa mensual; si i = 0, C = P / n)
 *
 * Es distinta de la de las compras normales (`calcularAmortizacion`: capital fijo + interés sobre saldo).
 */

/** Cuota fija (sin redondear) de un préstamo de `principal` a `numeroCuotas` con tasa mensual `tasaMensualPct` (2.15 = 2.15 %). */
export function cuotaFrancesa(principal: Decimal, tasaMensualPct: Decimal, numeroCuotas: number): Decimal {
  if (!Number.isInteger(numeroCuotas) || numeroCuotas < 1) throw new Error('numeroCuotas debe ser un entero mayor o igual a 1');
  const i = tasaMensualPct.div(100);
  if (i.isZero()) return principal.div(numeroCuotas);
  const factor = i.plus(1).pow(numeroCuotas);
  return principal.mul(i).mul(factor).div(factor.minus(1));
}

/**
 * Tasa mensual (%) que hace que una cuota fija `cuota` pague `principal` en `numeroCuotas` (la «tasa real» de lo que dice el banco,
 * con seguros y cargos incluidos). Búsqueda por bisección: la cuota crece con la tasa. `null` si la cuota no alcanza ni a devolver el
 * capital (cuota × cuotas < saldo) o si exigiría más de 20 % mensual.
 */
export function tasaImplicitaDeCuota(principal: Decimal, numeroCuotas: number, cuota: Decimal): Decimal | null {
  if (cuota.mul(numeroCuotas).lessThan(principal)) return null;
  let bajo = new Decimal(0);
  let alto = new Decimal(20);
  if (cuotaFrancesa(principal, alto, numeroCuotas).lessThan(cuota)) return null;
  if (cuotaFrancesa(principal, bajo, numeroCuotas).greaterThanOrEqualTo(cuota)) return bajo;
  for (let k = 0; k < 60; k += 1) {
    const medio = bajo.plus(alto).div(2);
    if (cuotaFrancesa(principal, medio, numeroCuotas).lessThan(cuota)) bajo = medio;
    else alto = medio;
  }
  return bajo.plus(alto).div(2);
}

/** Tasa efectiva anual (%) equivalente a una tasa mensual (%): (1 + m)¹² − 1. */
export function tasaEfectivaAnual(tasaMensualPct: Decimal): Decimal {
  return tasaMensualPct.div(100).plus(1).pow(12).minus(1).mul(100);
}

/** Tasa mensual (%) equivalente a una efectiva anual (%): (1 + ea)^(1/12) − 1. */
export function tasaMensualDesdeEfectivaAnual(eaPct: Decimal): Decimal {
  return eaPct.div(100).plus(1).pow(new Decimal(1).div(12)).minus(1).mul(100);
}

/**
 * Tabla de amortización francesa de una obligación nueva (p. ej. un refinanciamiento).
 *
 *  - Cada cuota se paga completa en `fecha de pago` (fin de mes, con la misma regla de corte que las compras: `diaCorteTarjeta`).
 *  - El interés de cada mes es `saldo × tasa` (la primera cuota SÍ cobra interés: el dinero ya estaba prestado).
 *  - Todo se redondea a centavos mes a mes, como en un extracto del banco; la última cuota cierra el saldo exacto.
 *  - `cuotaPactada` (la que dio el banco, con seguros o ajustes): reemplaza a la calculada. Debe cubrir el interés de cada mes y
 *    no puede pagar la deuda antes de la última cuota.
 */
export function calcularAmortizacionFrancesa(
  principal: Decimal,
  tasaMensualPct: Decimal,
  numeroCuotas: number,
  fechaInicio: Date,
  diaCorteTarjeta?: number | null,
  hoy: Date = todayLocal(),
  cuotaPactada?: Decimal | null,
): CuotaCalculada[] {
  if (!principal.greaterThan(0)) throw new Error('El saldo a financiar debe ser mayor a 0');
  if (tasaMensualPct.isNegative()) throw new Error('La tasa no puede ser negativa');
  const i = tasaMensualPct.div(100);
  const cuota = money(cuotaPactada ?? cuotaFrancesa(principal, tasaMensualPct, numeroCuotas));
  if (!cuota.greaterThan(0)) throw new Error('La cuota debe ser mayor a 0');

  const cuotas: CuotaCalculada[] = [];
  let saldo = money(principal);
  let fechaPago = calcularFechaPrimeraCuota(fechaInicio, diaCorteTarjeta);

  for (let k = 1; k <= numeroCuotas; k += 1) {
    const interes = money(saldo.mul(i));
    const ultima = k === numeroCuotas;
    let capital: Decimal;
    let pago: Decimal;
    if (ultima) {
      capital = saldo;
      pago = capital.plus(interes);
    } else {
      pago = cuota;
      capital = money(pago.minus(interes));
      if (!capital.greaterThan(0)) {
        throw new Error(`La cuota de ${pago.toString()} no alcanza a cubrir el interés del mes ${k} (${interes.toString()})`);
      }
      if (capital.greaterThanOrEqualTo(saldo)) {
        throw new Error(`La cuota pactada paga la deuda antes de la cuota ${numeroCuotas}: reduce la cuota o el número de cuotas`);
      }
    }
    const nuevoSaldo = saldo.minus(capital);
    cuotas.push({
      numeroCuota: k,
      fechaPago,
      saldoRestante: normalizeZero(money(nuevoSaldo)),
      interesPagado: interes,
      aporteCapital: money(capital),
      pagoTotal: money(pago),
      estado: isBefore(fechaPago, hoy) ? 'Pagado' : 'Pendiente',
      periodoFacturacion: periodoOf(fechaPago),
    });
    saldo = nuevoSaldo;
    fechaPago = endOfMonth(addMonths(fechaPago, 1));
  }
  return cuotas;
}
