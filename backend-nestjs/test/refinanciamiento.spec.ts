import { Decimal } from '../src/config/decimal.config';
import { calcularAmortizacionFrancesa, cuotaFrancesa, tasaEfectivaAnual, tasaImplicitaDeCuota, tasaMensualDesdeEfectivaAnual } from '../src/common/utils/amortizacion-francesa.util';
import { hoyBogota } from '../src/common/utils/date.util';
import {
  CompraUnificable,
  resolverTasaMensual,
  responsablesDeLaMaestra,
  resumenBarrido,
  simularRefinanciamiento,
  totalesDeSeleccion,
} from '../src/modules/compras-credito/refinanciamiento.util';

const d = (v: string | number) => new Decimal(v);
const dia = (iso: string) => new Date(`${iso}T00:00:00Z`);
const HOY = dia('2026-10-17');

/** Cuota de la fórmula con números de coma flotante: solo para contrastar. */
const cuotaFlotante = (p: number, i: number, n: number) => (i === 0 ? p / n : (p * i * (1 + i) ** n) / ((1 + i) ** n - 1));

describe('cuotaFrancesa', () => {
  it('coincide con la fórmula C = P·i·(1+i)ⁿ / ((1+i)ⁿ − 1)', () => {
    for (const [p, tasa, n] of [[10_000_000, 1.5, 12], [4_500_000, 1.87, 24], [750_000, 2.1, 6], [30_000_000, 0.9, 60]] as const) {
      expect(cuotaFrancesa(d(p), d(tasa), n).toNumber()).toBeCloseTo(cuotaFlotante(p, tasa / 100, n), 4);
    }
  });

  it('con tasa 0 es el saldo repartido en partes iguales', () => {
    expect(cuotaFrancesa(d(1200), d(0), 12).toNumber()).toBe(100);
  });

  it('número de cuotas inválido → error', () => {
    expect(() => cuotaFrancesa(d(1000), d(2), 0)).toThrow();
    expect(() => cuotaFrancesa(d(1000), d(2), 1.5)).toThrow();
  });
});

describe('conversión de tasas', () => {
  it('efectiva anual ↔ mensual', () => {
    expect(tasaMensualDesdeEfectivaAnual(d(20)).toNumber()).toBeCloseTo(1.530947, 5);
    expect(tasaEfectivaAnual(d(2)).toNumber()).toBeCloseTo(26.82418, 4);
    expect(tasaEfectivaAnual(tasaMensualDesdeEfectivaAnual(d('23.5'))).toNumber()).toBeCloseTo(23.5, 8);
  });

  it('resolverTasaMensual: exactamente una de las dos y dentro de un rango razonable', () => {
    expect(resolverTasaMensual(d('1.87'), null).toNumber()).toBe(1.87);
    expect(resolverTasaMensual(null, d(20)).toNumber()).toBe(1.5309);
    expect(() => resolverTasaMensual(null, null)).toThrow();
    expect(() => resolverTasaMensual(d(1), d(12))).toThrow();
    expect(() => resolverTasaMensual(d(-1), null)).toThrow();
    expect(() => resolverTasaMensual(d(25), null)).toThrow();
  });
});

describe('tasaImplicitaDeCuota', () => {
  it('es la tasa que hace que esa cuota pague el saldo: ida y vuelta con la fórmula', () => {
    for (const [p, tasa, n] of [[6_000_000, 1.5, 12], [9_927_258, 1.87, 12], [30_000_000, 0.9, 60]] as const) {
      const cuota = cuotaFrancesa(d(p), d(tasa), n);
      expect(tasaImplicitaDeCuota(d(p), n, cuota)?.toNumber()).toBeCloseTo(tasa, 6);
    }
  });

  it('una cuota exacta de saldo/cuotas implica tasa 0', () => {
    expect(tasaImplicitaDeCuota(d(1_200_000), 12, d(100_000))?.toNumber()).toBe(0);
  });

  it('una cuota que no devuelve ni el capital, o que pide más de 20 % mensual, no tiene tasa', () => {
    expect(tasaImplicitaDeCuota(d(1_200_000), 12, d(99_000))).toBeNull();
    expect(tasaImplicitaDeCuota(d(1_200_000), 12, d(1_150_000))).toBeNull();
  });

  it('una cuota mayor a la calculada implica una tasa mayor a la anunciada (seguros y cargos)', () => {
    const anunciada = cuotaFrancesa(d(6_000_000), d('1.5'), 12);
    expect(tasaImplicitaDeCuota(d(6_000_000), 12, anunciada.plus(15_000))!.toNumber()).toBeGreaterThan(1.5);
  });
});

describe('calcularAmortizacionFrancesa', () => {
  const tabla = (p: number, tasa: number, n: number, inicio = '2026-10-17', corte?: number, pactada?: number) =>
    calcularAmortizacionFrancesa(d(p), d(tasa), n, dia(inicio), corte, HOY, pactada === undefined ? null : d(pactada));

  it('cuota fija, saldo que llega exactamente a 0 y capital que suma el saldo', () => {
    const t = tabla(10_000_000, 1.5, 12);
    expect(t).toHaveLength(12);
    const cuotaFija = t[0].pagoTotal.toNumber();
    expect(cuotaFija).toBeCloseTo(cuotaFlotante(10_000_000, 0.015, 12), 2);
    for (const c of t.slice(0, 11)) expect(c.pagoTotal.toNumber()).toBe(cuotaFija);
    expect(t[11].pagoTotal.toNumber()).toBeCloseTo(cuotaFija, -1); // la última solo absorbe los centavos del redondeo
    expect(t[11].saldoRestante.toNumber()).toBe(0);
    expect(t.reduce((a, c) => a.plus(c.aporteCapital), d(0)).toNumber()).toBe(10_000_000);
    // cada cuota = capital + interés, el interés baja y el capital sube
    for (const c of t) expect(c.aporteCapital.plus(c.interesPagado).toNumber()).toBe(c.pagoTotal.toNumber());
    for (let k = 1; k < t.length; k++) {
      expect(t[k].interesPagado.toNumber()).toBeLessThan(t[k - 1].interesPagado.toNumber());
      expect(t[k].aporteCapital.toNumber()).toBeGreaterThan(t[k - 1].aporteCapital.toNumber());
    }
  });

  it('la primera cuota SÍ cobra interés (saldo × tasa)', () => {
    expect(tabla(1_000_000, 2, 6)[0].interesPagado.toNumber()).toBe(20_000);
  });

  it('con tasa 0 no hay interés', () => {
    const t = tabla(1_200_000, 0, 12);
    expect(t.every((c) => c.interesPagado.isZero())).toBe(true);
    expect(t.every((c) => c.pagoTotal.toNumber() === 100_000)).toBe(true);
  });

  it('una sola cuota paga todo el saldo más un mes de interés', () => {
    const t = tabla(1_000_000, 2, 1);
    expect(t).toHaveLength(1);
    expect(t[0].pagoTotal.toNumber()).toBe(1_020_000);
    expect(t[0].saldoRestante.toNumber()).toBe(0);
  });

  it('las fechas son fin de mes según el corte de la tarjeta; el estado, según hoy', () => {
    const antesDelCorte = tabla(1_000_000, 2, 3, '2026-10-10', 15);
    expect(antesDelCorte.map((c) => c.fechaPago.toISOString().slice(0, 10))).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']);
    expect(antesDelCorte.map((c) => c.periodoFacturacion)).toEqual(['2026-10', '2026-11', '2026-12']);
    const despues = tabla(1_000_000, 2, 3, '2026-10-17', 15);
    expect(despues[0].fechaPago.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(despues.every((c) => c.estado === 'Pendiente')).toBe(true);
    expect(calcularAmortizacionFrancesa(d(1000), d(1), 2, dia('2026-01-05'), 15, HOY)[0].estado).toBe('Pagado'); // ya venció
  });

  it('con la cuota que dio el banco (mayor que la calculada) la tabla termina con una última cuota menor', () => {
    const calculada = cuotaFlotante(5_000_000, 0.0187, 12);
    const t = tabla(5_000_000, 1.87, 12, '2026-10-17', 15, Math.ceil(calculada) + 5_000);
    expect(t[0].pagoTotal.toNumber()).toBe(Math.ceil(calculada) + 5_000);
    expect(t[11].pagoTotal.toNumber()).toBeLessThan(t[0].pagoTotal.toNumber());
    expect(t[11].saldoRestante.toNumber()).toBe(0);
    expect(t.reduce((a, c) => a.plus(c.aporteCapital), d(0)).toNumber()).toBe(5_000_000);
  });

  it('una cuota que no cubre el interés, o que paga la deuda antes de tiempo, se rechaza con un mensaje claro', () => {
    expect(() => tabla(5_000_000, 2, 12, '2026-10-17', 15, 50_000)).toThrow(/no alcanza a cubrir el interés/);
    expect(() => tabla(5_000_000, 2, 12, '2026-10-17', 15, 2_000_000)).toThrow(/paga la deuda antes/);
  });

  it('rechaza saldo no positivo o tasa negativa', () => {
    expect(() => tabla(0, 2, 12)).toThrow();
    expect(() => tabla(1000, -1, 12)).toThrow();
  });
});

describe('simularRefinanciamiento', () => {
  const entrada = (extra: Partial<Parameters<typeof simularRefinanciamiento>[0]> = {}) => ({
    saldo: d(6_000_000),
    numeroCuotas: 12,
    tasaMensualPct: d('1.5'),
    cuotaActualCombinada: d(900_000),
    restantePorPagar: d(7_200_000),
    fechaInicio: dia('2026-10-17'),
    diaCorteTarjeta: 15,
    hoy: HOY,
    ...extra,
  });

  it('compara cuota actual vs. nueva, el costo total y el ahorro de todo el plazo', () => {
    const r = simularRefinanciamiento(entrada());
    expect((r.cuotaCalculada as Decimal).toNumber()).toBeCloseTo(cuotaFlotante(6_000_000, 0.015, 12), 2);
    expect(r.cuotaUsada.toNumber()).toBe((r.cuotaCalculada as Decimal).toNumber());
    expect(r.cuotaPactada).toBeNull();
    expect(r.totalAPagar.toNumber()).toBeCloseTo((r.cuotaCalculada as Decimal).toNumber() * 12, 0);
    expect(r.interesTotal.toNumber()).toBeCloseTo(r.totalAPagar.toNumber() - 6_000_000, 2);
    expect(r.diferenciaMensual.toNumber()).toBeCloseTo(900_000 - (r.cuotaCalculada as Decimal).toNumber(), 2); // se libera caja cada mes
    expect(r.diferenciaTotal.toNumber()).toBeCloseTo(7_200_000 - r.totalAPagar.toNumber(), 2);
    expect(r.tasaEfectivaAnualPct.toNumber()).toBeCloseTo(19.56, 2);
    expect(r.cuotas).toHaveLength(12);
  });

  it('acepta la tasa efectiva anual en lugar de la mensual', () => {
    const r = simularRefinanciamiento(entrada({ tasaMensualPct: null, tasaEfectivaAnualPct: d(20) }));
    expect(r.tasaMensualPct.toNumber()).toBe(1.5309);
    expect(r.tasaEfectivaAnualPct.toNumber()).toBeCloseTo(20, 1);
    expect(r.tasaInformadaPct?.toNumber()).toBe(1.5309);
  });

  it('con la cuota pactada por el banco la tabla usa esa cuota y la tasa REAL que implica (con seguros y cargos)', () => {
    const base = simularRefinanciamiento(entrada());
    const pactada = Math.round(((base.cuotaCalculada as Decimal).toNumber() + 12_000) * 100) / 100; // «con seguros»
    const r = simularRefinanciamiento(entrada({ cuotaPactada: d(pactada) }));
    expect(r.cuotaPactada?.toNumber()).toBe(pactada);
    expect(r.cuotaUsada.toNumber()).toBe(pactada);
    expect(r.cuotaCalculada?.toNumber()).toBe(base.cuotaCalculada?.toNumber()); // la de la fórmula con la tasa anunciada
    expect(r.tasaInformadaPct?.toNumber()).toBe(1.5);
    expect(r.tasaMensualPct.toNumber()).toBeGreaterThan(1.5); // la que de verdad se paga
    expect(r.cuotas).toHaveLength(12); // cierra en el plazo pedido, sin terminar antes
    expect(r.cuotas[0].pagoTotal.toNumber()).toBe(pactada);
    expect(r.cuotas[11].saldoRestante.toNumber()).toBe(0);
    expect(r.diferenciaMensual.toNumber()).toBeCloseTo(900_000 - pactada, 2);
  });

  it('basta la cuota del banco: sin tasa informada se deduce la tasa y no hay cuota calculada', () => {
    const r = simularRefinanciamiento(entrada({ tasaMensualPct: null, cuotaPactada: d(560_000) }));
    expect(r.tasaInformadaPct).toBeNull();
    expect(r.cuotaCalculada).toBeNull();
    expect(r.tasaMensualPct.toNumber()).toBeGreaterThan(1.5);
    expect(r.tasaMensualPct.toNumber()).toBeLessThan(2.5);
    expect(r.cuotas[0].pagoTotal.toNumber()).toBe(560_000);
    expect(r.cuotas[11].saldoRestante.toNumber()).toBe(0);
  });

  it('si la cuota sube (plazo corto) la diferencia mensual es negativa', () => {
    const r = simularRefinanciamiento(entrada({ numeroCuotas: 4, cuotaActualCombinada: d(300_000) }));
    expect(r.diferenciaMensual.toNumber()).toBeLessThan(0);
  });

  it('datos inválidos → 400 con el campo que corresponde', () => {
    const campo = (e: Parameters<typeof simularRefinanciamiento>[0]) => {
      try {
        simularRefinanciamiento(e);
        return null;
      } catch (error) {
        return Object.keys(((error as { response?: { errors?: object } }).response?.errors ?? {}) as object)[0] ?? 'otro';
      }
    };
    expect(campo(entrada({ saldo: d(0) }))).toBe('saldo');
    expect(campo(entrada({ numeroCuotas: 0 }))).toBe('numeroCuotas');
    expect(campo(entrada({ numeroCuotas: 121 }))).toBe('numeroCuotas');
    expect(campo(entrada({ tasaMensualPct: null }))).toBe('tasa'); // ni tasa ni cuota
    expect(campo(entrada({ cuotaPactada: d(10_000) }))).toBe('cuotaMensual'); // no alcanza a pagar el saldo
    expect(campo(entrada({ cuotaPactada: d(5_990_000) }))).toBe('cuotaMensual'); // implicaría una tasa absurda
  });
});

describe('totalesDeSeleccion y responsablesDeLaMaestra', () => {
  const compra = (id: number, saldo: number, proxima: number, restante: number, responsables: Array<[number, number]> = []): CompraUnificable => ({
    id,
    saldoCapital: d(saldo),
    cuotaProxima: d(proxima),
    restantePorPagar: d(restante),
    responsables: responsables.map(([personaId, pct]) => ({ personaId, porcentaje: d(pct) })),
  });

  it('suma el saldo, la cuota actual combinada y lo que falta por pagar', () => {
    const t = totalesDeSeleccion([compra(1, 1_000_000, 100_000, 1_150_000), compra(2, 3_000_000, 250_500.5, 3_400_000)]);
    expect(t.saldo.toNumber()).toBe(4_000_000);
    expect(t.cuotaActualCombinada.toNumber()).toBe(350_500.5);
    expect(t.restantePorPagar.toNumber()).toBe(4_550_000);
    expect(totalesDeSeleccion([]).saldo.toNumber()).toBe(0);
  });

  it('cada persona conserva su parte, en proporción al capital que se llevó cada compra', () => {
    // Felipe (1) tiene el 100 % de $1 M; Andrés (2) tiene el 50 % de $3 M; el resto de la segunda es del titular
    const r = responsablesDeLaMaestra([compra(1, 1_000_000, 0, 0, [[1, 100]]), compra(2, 3_000_000, 0, 0, [[2, 50]])], d(4_000_000));
    expect(r.map((x) => [x.personaId, x.porcentaje.toNumber(), x.monto.toNumber()])).toEqual([
      [2, 37.5, 1_500_000],
      [1, 25, 1_000_000],
    ]);
  });

  it('sin responsables nadie es cargado; los porcentajes nunca suman más de 100 aunque haya redondeo', () => {
    expect(responsablesDeLaMaestra([compra(1, 1_000_000, 0, 0)], d(1_000_000))).toEqual([]);
    expect(responsablesDeLaMaestra([], d(0))).toEqual([]);
    const tres = responsablesDeLaMaestra([compra(1, 100, 0, 0, [[1, 100]]), compra(2, 100, 0, 0, [[2, 100]]), compra(3, 100, 0, 0, [[3, 100]])], d(300));
    const suma = tres.reduce((a, x) => a.plus(x.porcentaje), d(0)).toNumber();
    expect(suma).toBeLessThanOrEqual(100);
    expect(suma).toBeGreaterThan(99.9);
    expect(tres.every((x) => x.porcentaje.toNumber() > 33)).toBe(true);
  });
});

describe('resumenBarrido (Fase 3 · barrido por fecha de corte)', () => {
  const compra = (id: number, saldo: number): CompraUnificable => ({ id, saldoCapital: d(saldo), cuotaProxima: d(0), restantePorPagar: d(0), responsables: [] });

  it('capital teórico = suma de saldos; ajuste = valor del banco − capital teórico', () => {
    const r = resumenBarrido([compra(1, 1_000_000), compra(2, 2_500_000)], d(3_800_000));
    expect(r.capitalTeorico.toNumber()).toBe(3_500_000);
    expect(r.montoUnificadoBanco.toNumber()).toBe(3_800_000);
    expect(r.ajusteBanco.toNumber()).toBe(300_000);
    expect(r.cantidadCompras).toBe(2);
  });

  it('ajuste negativo si el banco fijó menos que el capital teórico; cero compras → capital 0', () => {
    expect(resumenBarrido([compra(1, 1_000_000)], d(900_000)).ajusteBanco.toNumber()).toBe(-100_000);
    expect(resumenBarrido([], d(500_000)).capitalTeorico.toNumber()).toBe(0);
  });

  it('el valor del banco debe ser positivo', () => {
    expect(() => resumenBarrido([compra(1, 100)], d(0))).toThrow();
  });
});

describe('hoyBogota', () => {
  it('el día de Colombia, sin importar la zona horaria del servidor', () => {
    expect(hoyBogota(new Date('2026-10-06T04:30:00Z')).toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(hoyBogota(new Date('2026-10-06T05:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-06');
    expect(hoyBogota(new Date('2027-01-01T03:00:00Z')).toISOString().slice(0, 10)).toBe('2026-12-31');
  });
});
