import { Decimal } from '../../config/decimal.config';
import { addMonths, endOfMonth, isBefore, periodoOf, todayLocal } from './date.util';
import { money, normalizeZero } from './decimal.util';

/**
 * Cuota calculada. Equivale a `CalculadoraAmortizacion.CuotaDetalle` de Scala (id/compra se asignan al persistir),
 * más `periodoFacturacion` (YYYY-MM) exigido por el esquema Supabase.
 */
export interface CuotaCalculada {
  numeroCuota: number;
  fechaPago: Date;
  saldoRestante: Decimal;
  interesPagado: Decimal;
  aporteCapital: Decimal;
  pagoTotal: Decimal;
  estado: string;
  periodoFacturacion: string;
}

/** Día de corte por defecto de la regla legacy de Scala (`diaDelMes <= 15`). */
export const DIA_CORTE_LEGACY = 15;

/**
 * Fecha de pago de la primera cuota (siempre fin de mes).
 *  - Legacy (`CalculadoraAmortizacion.calcularFechaPrimeraCuota`): día <= 15 → fin del mes de la compra;
 *    día > 15 → fin del mes siguiente.
 *  - Con `diaCorteTarjeta` (Tarjetas.dia_corte): día <= dia_corte → fin del mes actual; si no, mes siguiente.
 */
export function calcularFechaPrimeraCuota(fechaCompra: Date, diaCorteTarjeta?: number | null): Date {
  const limite = diaCorteTarjeta && diaCorteTarjeta > 0 ? diaCorteTarjeta : DIA_CORTE_LEGACY;
  return fechaCompra.getUTCDate() <= limite ? endOfMonth(fechaCompra) : endOfMonth(addMonths(fechaCompra, 1));
}

/**
 * Tabla de amortización — migración exacta de `CalculadoraAmortizacion.calcularAmortizacion` (Scala).
 *
 * Reglas heredadas:
 *  - Capital fijo por cuota = valorCompra / numeroCuotas.
 *  - Interés mensual sobre el saldo antes de pagar la cuota.
 *  - Cuota 1: si `cobraInteresPrimeraCuota` es false, el interés NO se cobra y se acumula para la cuota 2.
 *  - Cada cuota se redondea a 2 decimales (HALF_UP) solo al emitir; el cálculo interno usa Decimal sin redondear.
 *  - Estado: 'Pagado' si fechaPago < hoy, si no 'Pendiente'.
 *
 * @param interesMensualPorcentaje porcentaje mensual (2.15 = 2.15 %)
 * @param hoy inyectable para pruebas deterministas
 */
export function calcularAmortizacion(
  valorCompra: Decimal,
  interesMensualPorcentaje: Decimal,
  numeroCuotas: number,
  fechaCompra: Date,
  cobraInteresPrimeraCuota: boolean,
  diaCorteTarjeta?: number | null,
  hoy: Date = todayLocal(),
): CuotaCalculada[] {
  if (!Number.isInteger(numeroCuotas) || numeroCuotas < 1) {
    throw new Error('numeroCuotas debe ser un entero mayor o igual a 1');
  }
  if (!(fechaCompra instanceof Date) || Number.isNaN(fechaCompra.getTime())) {
    throw new Error('Date cannot be null');
  }

  const interesMensual = interesMensualPorcentaje.div(100);
  const aporteCapitalFijo = valorCompra.div(numeroCuotas);

  const cuotas: CuotaCalculada[] = [];
  let saldoRestante = valorCompra;
  let interesAcumulado = new Decimal(0);
  let fechaPago = calcularFechaPrimeraCuota(fechaCompra, diaCorteTarjeta);

  for (let k = 1; k <= numeroCuotas; k += 1) {
    const interesDelMes = saldoRestante.mul(interesMensual);
    let interesPagado: Decimal;
    let nuevoInteresAcumulado = new Decimal(0);

    if (k === 1) {
      if (cobraInteresPrimeraCuota) {
        interesPagado = interesDelMes;
      } else {
        interesPagado = new Decimal(0);
        nuevoInteresAcumulado = interesDelMes;
      }
    } else if (interesAcumulado.greaterThan(0)) {
      interesPagado = interesAcumulado.plus(interesDelMes);
    } else {
      interesPagado = interesDelMes;
    }

    const pagoTotal = aporteCapitalFijo.plus(interesPagado);
    const nuevoSaldo = saldoRestante.minus(aporteCapitalFijo);

    cuotas.push({
      numeroCuota: k,
      fechaPago,
      saldoRestante: money(nuevoSaldo),
      interesPagado: money(interesPagado),
      aporteCapital: money(aporteCapitalFijo),
      pagoTotal: money(pagoTotal),
      estado: isBefore(fechaPago, hoy) ? 'Pagado' : 'Pendiente',
      periodoFacturacion: periodoOf(fechaPago),
    });

    saldoRestante = nuevoSaldo;
    interesAcumulado = nuevoInteresAcumulado;
    fechaPago = endOfMonth(addMonths(fechaPago, 1));
  }

  return cuotas.map((c) => ({ ...c, saldoRestante: normalizeZero(c.saldoRestante) }));
}

/** Cuota mensual promedio guardada en `ComprasCredito.pago_mensual` (misma fórmula que `CompraCreditoServicio.save`). */
export function calcularPagoMensualTotal(
  valorCompra: Decimal,
  interesPorcentaje: Decimal,
  numeroCuotas: number,
): Decimal {
  const pagoMensualBase = valorCompra.div(numeroCuotas);
  const interesMensual = pagoMensualBase.mul(interesPorcentaje.div(100));
  return money(pagoMensualBase.plus(interesMensual));
}
