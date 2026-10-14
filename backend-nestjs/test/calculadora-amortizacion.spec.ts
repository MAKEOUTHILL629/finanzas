import { Decimal } from '../src/config/decimal.config';
import {
  calcularAmortizacion,
  calcularFechaPrimeraCuota,
  calcularPagoMensualTotal,
} from '../src/common/utils/calculadora-amortizacion.util';
import { addMonths, endOfMonth, formatIsoDate, parseIsoDate, periodoOf } from '../src/common/utils/date.util';
import { money, rate, sumDecimals, toDecimal } from '../src/common/utils/decimal.util';

const d = (v: string | number) => new Decimal(v);
const date = (iso: string) => {
  const parsed = parseIsoDate(iso);
  if (!parsed) throw new Error(`fecha inválida ${iso}`);
  return parsed;
};
const HOY = date('2024-06-15');
const fixed = (v: Decimal) => v.toFixed(2);

/**
 * Vectores calculados a mano siguiendo EXACTAMENTE el algoritmo de
 * `CalculadoraAmortizacion.calcularAmortizacion` (Scala). El único test Scala existente
 * (CompraCreditoServicioTest) verifica llamadas a mocks, no cifras; estas son las cifras de referencia.
 */
describe('CalculadoraAmortizacion — vector A: 1000, 5 %, 10 cuotas, compra 2024-01-10, sin cobrar interés en cuota 1', () => {
  const cuotas = calcularAmortizacion(d(1000), d(5), 10, date('2024-01-10'), false, null, HOY);

  it('genera 10 cuotas numeradas 1..10', () => {
    expect(cuotas.map((c) => c.numeroCuota)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('cuota 1: interés diferido (0), pago = capital; el interés se acumula para la cuota 2', () => {
    expect(cuotas[0]).toMatchObject({ estado: 'Pagado', periodoFacturacion: '2024-01' });
    expect(fixed(cuotas[0].interesPagado)).toBe('0.00');
    expect(fixed(cuotas[0].aporteCapital)).toBe('100.00');
    expect(fixed(cuotas[0].pagoTotal)).toBe('100.00');
    expect(fixed(cuotas[0].saldoRestante)).toBe('900.00');
    expect(formatIsoDate(cuotas[0].fechaPago)).toBe('2024-01-31');
  });

  it('cuota 2: interés = acumulado(50) + 5 % de 900 = 95.00', () => {
    expect(fixed(cuotas[1].interesPagado)).toBe('95.00');
    expect(fixed(cuotas[1].pagoTotal)).toBe('195.00');
    expect(fixed(cuotas[1].saldoRestante)).toBe('800.00');
    expect(formatIsoDate(cuotas[1].fechaPago)).toBe('2024-02-29'); // 2024 bisiesto
  });

  it('tabla completa de interés, pago y saldo', () => {
    expect(cuotas.map((c) => fixed(c.interesPagado))).toEqual([
      '0.00', '95.00', '40.00', '35.00', '30.00', '25.00', '20.00', '15.00', '10.00', '5.00',
    ]);
    expect(cuotas.map((c) => fixed(c.pagoTotal))).toEqual([
      '100.00', '195.00', '140.00', '135.00', '130.00', '125.00', '120.00', '115.00', '110.00', '105.00',
    ]);
    expect(cuotas.map((c) => fixed(c.saldoRestante))).toEqual([
      '900.00', '800.00', '700.00', '600.00', '500.00', '400.00', '300.00', '200.00', '100.00', '0.00',
    ]);
  });

  it('fechas de pago: fin de mes consecutivo; estado según "hoy"', () => {
    expect(cuotas.map((c) => formatIsoDate(c.fechaPago))).toEqual([
      '2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31',
      '2024-06-30', '2024-07-31', '2024-08-31', '2024-09-30', '2024-10-31',
    ]);
    expect(cuotas.map((c) => c.estado)).toEqual([
      'Pagado', 'Pagado', 'Pagado', 'Pagado', 'Pagado',
      'Pendiente', 'Pendiente', 'Pendiente', 'Pendiente', 'Pendiente',
    ]);
  });

  it('el total pagado es capital + intereses (1000 + 275 = 1275)', () => {
    expect(fixed(sumDecimals(cuotas.map((c) => c.pagoTotal)))).toBe('1275.00');
    expect(fixed(sumDecimals(cuotas.map((c) => c.aporteCapital)))).toBe('1000.00');
  });
});

describe('CalculadoraAmortizacion — vector B: cobraInteresPrimeraCuota = true (ajuste de interés)', () => {
  const cuotas = calcularAmortizacion(d(1000), d(5), 10, date('2024-01-10'), true, null, HOY);

  it('cuota 1 ya cobra el interés (5 % de 1000 = 50)', () => {
    expect(fixed(cuotas[0].interesPagado)).toBe('50.00');
    expect(fixed(cuotas[0].pagoTotal)).toBe('150.00');
    expect(fixed(cuotas[0].saldoRestante)).toBe('900.00');
  });

  it('cuota 2 cobra solo su propio interés (45)', () => {
    expect(fixed(cuotas[1].interesPagado)).toBe('45.00');
    expect(fixed(cuotas[1].pagoTotal)).toBe('145.00');
  });

  it('mismo total que sin diferir (1275)', () => {
    expect(fixed(sumDecimals(cuotas.map((c) => c.pagoTotal)))).toBe('1275.00');
  });
});

describe('CalculadoraAmortizacion — redondeo HALF_UP a 2 decimales (1000, 1.8895 %, 3 cuotas)', () => {
  const cuotas = calcularAmortizacion(d(1000), d('1.8895'), 3, date('2024-03-05'), true, null, HOY);

  it('18.895 → 18.90 (HALF_UP exacto, sin error binario de Float)', () => {
    expect(fixed(cuotas[0].interesPagado)).toBe('18.90');
    expect(fixed(cuotas[0].pagoTotal)).toBe('352.23');
    expect(fixed(cuotas[0].aporteCapital)).toBe('333.33');
    expect(fixed(cuotas[0].saldoRestante)).toBe('666.67');
  });

  it('cuotas 2 y 3', () => {
    expect(fixed(cuotas[1].interesPagado)).toBe('12.60');
    expect(fixed(cuotas[1].pagoTotal)).toBe('345.93');
    expect(fixed(cuotas[1].saldoRestante)).toBe('333.33');
    expect(fixed(cuotas[2].interesPagado)).toBe('6.30');
    expect(fixed(cuotas[2].pagoTotal)).toBe('339.63');
  });

  it('el saldo final es exactamente 0.00 (nunca "-0.00")', () => {
    expect(fixed(cuotas[2].saldoRestante)).toBe('0.00');
    expect(cuotas[2].saldoRestante.isNegative() && !cuotas[2].saldoRestante.isZero()).toBe(false);
    expect(Object.is(cuotas[2].saldoRestante.toNumber(), -0)).toBe(false);
  });
});

describe('CalculadoraAmortizacion — fecha de la primera cuota', () => {
  it('día <= 15 → fin del mes de la compra (regla legacy: el 15 incluido)', () => {
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-01-01')))).toBe('2024-01-31');
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-01-14')))).toBe('2024-01-31');
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-01-15')))).toBe('2024-01-31');
  });

  it('día > 15 → fin del mes siguiente', () => {
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-01-16')))).toBe('2024-02-29');
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-01-31')))).toBe('2024-02-29');
  });

  it('cruce de año: 2024-12-20 → 2025-01-31', () => {
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-12-20')))).toBe('2025-01-31');
  });

  it('con Tarjetas.dia_corte configurado se usa en lugar de 15', () => {
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-03-20'), 25))).toBe('2024-03-31');
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-03-20'), 10))).toBe('2024-04-30');
    expect(formatIsoDate(calcularFechaPrimeraCuota(date('2024-03-20'), null))).toBe('2024-04-30');
  });

  it('el día de corte de la tarjeta se propaga a toda la tabla de amortización', () => {
    const cuotas = calcularAmortizacion(d(300), d(0), 3, date('2024-03-20'), false, 25, HOY);
    expect(cuotas.map((c) => formatIsoDate(c.fechaPago))).toEqual(['2024-03-31', '2024-04-30', '2024-05-31']);
    expect(cuotas.map((c) => c.periodoFacturacion)).toEqual(['2024-03', '2024-04', '2024-05']);
  });
});

describe('CalculadoraAmortizacion — multimoneda (USD → COP) con Decimal', () => {
  it('USD 100 × TRM 4200 = 420000 COP en 3 cuotas sin interés → 140000.00 c/u', () => {
    const valorCop = money(d(100).mul(d('4200')));
    expect(fixed(valorCop)).toBe('420000.00');
    const cuotas = calcularAmortizacion(valorCop, d(0), 3, date('2024-08-02'), false, null, HOY);
    expect(cuotas.map((c) => fixed(c.pagoTotal))).toEqual(['140000.00', '140000.00', '140000.00']);
    expect(cuotas.map((c) => fixed(c.saldoRestante))).toEqual(['280000.00', '140000.00', '0.00']);
  });

  it('USD 49.99 × TRM 4150.1234 = 207464.67 (sin deriva IEEE 754)', () => {
    const valorCop = money(d('49.99').mul(d('4150.1234')));
    expect(fixed(valorCop)).toBe('207464.67');
    // El mismo cálculo con number flotante nativo NO es fiable: se documenta por qué existe la Regla 1.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(fixed(d('0.1').plus('0.2'))).toBe('0.30');
  });

  it('confirmar TRM: factor de ajuste = nuevaTrm / trmAnterior (misma fórmula que sp_actualizar_trm_compra_usd)', () => {
    const factor = d('4150').div(d('4200'));
    expect(fixed(money(d('140000').mul(factor)))).toBe('138333.33');
  });
});

describe('CalculadoraAmortizacion — validaciones', () => {
  it('rechaza numeroCuotas < 1 o no entero', () => {
    expect(() => calcularAmortizacion(d(1000), d(5), 0, date('2024-01-10'), false)).toThrow();
    expect(() => calcularAmortizacion(d(1000), d(5), 1.5, date('2024-01-10'), false)).toThrow();
  });

  it('rechaza fecha de compra inválida', () => {
    expect(() => calcularAmortizacion(d(1000), d(5), 3, new Date('x'), false)).toThrow('Date cannot be null');
  });

  it('una sola cuota con interés cobrado', () => {
    const [c] = calcularAmortizacion(d(1000), d(2), 1, date('2024-01-10'), true, null, HOY);
    expect(fixed(c.pagoTotal)).toBe('1020.00');
    expect(fixed(c.saldoRestante)).toBe('0.00');
  });

  it('una sola cuota sin cobrar interés: el interés diferido nunca se cobra (comportamiento legacy)', () => {
    const [c] = calcularAmortizacion(d(1000), d(2), 1, date('2024-01-10'), false, null, HOY);
    expect(fixed(c.pagoTotal)).toBe('1000.00');
  });
});

describe('pago mensual de cabecera (CompraCreditoServicio.save)', () => {
  it('pagoMensual = valor/n + interés sobre esa cuota base', () => {
    // 1200 / 12 = 100; 100 * 2.5 % = 2.5 → 102.50
    expect(fixed(calcularPagoMensualTotal(d(1200), d('2.5'), 12))).toBe('102.50');
    // 1000 / 3 = 333.3333…; × 1.1 % → 337.00 (333.3333 + 3.6666)
    expect(fixed(calcularPagoMensualTotal(d(1000), d(1.1), 3))).toBe('337.00');
  });
});

describe('utilidades de Decimal y fechas', () => {
  it('money() redondea a 2 decimales y rate() a 4 con HALF_UP', () => {
    expect(fixed(money(d('2.675')))).toBe('2.68');
    expect(rate(d('4150.12345')).toFixed(4)).toBe('4150.1235');
    expect(money(d('-0.001')).toFixed(2)).toBe('0.00');
  });

  it('toDecimal convierte desde string/number/bigint y trata null como 0', () => {
    expect(toDecimal('12.30').toFixed(2)).toBe('12.30');
    expect(toDecimal(0.1).plus(toDecimal(0.2)).toString()).toBe('0.3');
    expect(toDecimal(10n).toString()).toBe('10');
    expect(toDecimal(null).toString()).toBe('0');
  });

  it('addMonths y endOfMonth respetan el calendario', () => {
    expect(formatIsoDate(addMonths(date('2024-01-31'), 1))).toBe('2024-02-29');
    expect(formatIsoDate(addMonths(date('2023-01-31'), 1))).toBe('2023-02-28');
    expect(formatIsoDate(endOfMonth(date('2024-02-10')))).toBe('2024-02-29');
    expect(periodoOf(date('2026-10-05'))).toBe('2026-10');
  });

  it('parseIsoDate es estricto', () => {
    expect(parseIsoDate('2024-02-30')).toBeNull();
    expect(parseIsoDate('05/04/2024')).toBeNull();
    expect(parseIsoDate('2024-4-5')).toBeNull();
    expect(formatIsoDate(parseIsoDate('2024-04-05') as Date)).toBe('2024-04-05');
  });
});
