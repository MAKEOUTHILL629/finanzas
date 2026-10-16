/* eslint-disable @typescript-eslint/no-explicit-any */
import { TipoTransaccion } from '../../src/common/enums/finance.enums';
import { CompraCreditoInput } from '../../src/modules/compras-credito/dto/compra-credito.dto';
import { crearServicios, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * `GET /api/dashboard/summary` contra PostgreSQL real: las cifras del inicio deben coincidir con las de cada módulo
 * (cuentas, flujo de caja, extractos, estado de cuenta de personas).
 */
describeDb('Integración BD — dashboard de inicio', () => {
  let s: Servicios;
  let semilla: Semilla;
  const P = mesRelativo(0);
  const n = (x: { toString(): string } | null | undefined) => (x === null || x === undefined ? null : x.toString());

  beforeAll(async () => {
    await prepararEsquema();
    s = await crearServicios();
  });
  afterAll(async () => {
    await s.prisma.$disconnect();
  });
  beforeEach(async () => {
    await vaciarTablas();
    semilla = await sembrar(s.prisma);
    await s.prisma.tarjetas.update({ where: { id: BigInt(semilla.tarjetaId) }, data: { cupo_total: '10000000', dia_corte: 15, dia_limite_pago: 5 } });
  });

  const compra = (extra: Partial<CompraCreditoInput>): CompraCreditoInput => ({
    concepto: 'Nevera',
    valorCompra: 1200000,
    fechaCompra: `${mesRelativo(-1)}-10`,
    numeroCuotas: 12,
    interes: 0,
    descripcion: 'Éxito',
    estado: 'Pendiente',
    tarjeta: semilla.tarjetaId,
    ...extra,
  });

  async function sembrarCompras() {
    const a = await s.compras.save(compra({}), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: a }, semilla.userId);
    await s.responsables.create({ persona: semilla.yoId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: a }, semilla.userId);
    const b = await s.compras.save(compra({ concepto: 'Celular', valorCompra: 600000, numeroCuotas: 6, fechaCompra: `${P}-05` }), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 100, cantidadPago: 300000, cantidadCuotas: 3, compraCredito: b }, semilla.userId);
  }

  const resumen = () => s.dashboard.resumen(semilla.userId, P, new Date(`${P}-16T12:00:00`));

  it('sin datos: ceros, listas vacías y el nombre del usuario', async () => {
    const d = await resumen();
    expect(d.periodo).toBe(P);
    expect(d.usuario.nombre).toBe('Felipe');
    expect(n(d.liquidez.total)).toBe('1000000'); // la cuenta de la semilla
    expect(d.tarjetas.items).toHaveLength(1);
    expect(n(d.tarjetas.items[0].pagoDelMes)).toBe('0');
    expect(d.porCobrar.topDeudores).toEqual([]);
    expect(d.proximosVencimientos).toEqual([]);
    expect(d.movimientosRecientes).toEqual([]);
    expect(d.alertas).toEqual({ movimientosPorRevisar: 0, correosPendientes: 0, pagosPorAprobar: 0 });
  });

  it('liquidez: solo cuentas activas, en pesos; las otras monedas aparte', async () => {
    await s.prisma.cuentasFinancieras.create({ data: { owner_user_id: semilla.userId, nombre: 'Dólares', tipo_cuenta: 'AHORROS', moneda: 'USD', saldo_actual: '250' } });
    await s.prisma.cuentasFinancieras.create({ data: { owner_user_id: semilla.userId, nombre: 'Vieja', tipo_cuenta: 'AHORROS', saldo_actual: '999999', is_active: false } });
    const d = await resumen();
    expect(n(d.liquidez.total)).toBe('1000000');
    expect(d.liquidez.otrasMonedas.map((o) => [o.moneda, n(o.saldo)])).toEqual([['USD', '250']]);
    expect(d.liquidez.cuentas.map((c) => c.nombre)).not.toContain('Vieja');
    expect(d.liquidez.numeroCuentas).toBe(3);
  });

  it('flujo del mes y movimientos recientes coinciden con las transacciones', async () => {
    await s.transacciones.create({ tipoTransaccion: TipoTransaccion.INGRESO, cuentaDestinoId: semilla.bancolombiaId, concepto: 'Nómina', montoOriginal: 5000000 }, semilla.userId);
    await s.transacciones.create({ tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Mercado', montoOriginal: 200000 }, semilla.userId);
    const d = await resumen();
    expect(n(d.flujoMes.ingresos)).toBe('5000000');
    expect(n(d.flujoMes.egresosDirectos)).toBe('200000');
    expect(n(d.liquidez.total)).toBe('5800000'); // 1.000.000 + 5.000.000 − 200.000 (Trigger 2)
    expect(d.movimientosRecientes.map((m) => m.concepto)).toEqual(['Mercado', 'Nómina']);
    expect(d.movimientosRecientes[0]).toMatchObject({ tipo: 'EGRESO', cuenta: 'Bancolombia' });
    // coincide con el módulo de flujo de caja
    const flujo = await s.subledger.flujoCaja(P, semilla.userId);
    expect(n(d.flujoMes.gastosPropios)).toBe(n(flujo.gasto_neto_real_tuyo));
    expect(n(d.flujoMes.flujoLibre)).toBe(n(flujo.flujo_caja_libre_estimado));
  });

  it('tarjetas: el extracto del mes se reparte entre mi parte y terceros, con cupo usado y próximo vencimiento', async () => {
    await sembrarCompras();
    const d = await resumen();
    const t = d.tarjetas.items[0];

    expect(n(t.pagoDelMes)).toBe('200000'); // nevera 100000 + celular 100000
    expect(n(t.terceros)).toBe('150000'); // Andrés: 50 % de la nevera + el 100 % del celular
    expect(n(t.miParte)).toBe('50000');
    expect(n(d.tarjetas.totales.pagoDelMes)).toBe('200000');
    expect(n(d.tarjetas.totales.terceros)).toBe('150000');

    // lo pendiente coincide con las cuotas sin pagar de la base
    const [{ pendiente, capital }] = await s.prisma.$queryRawUnsafe<Array<{ pendiente: any; capital: any }>>(`
      SELECT COALESCE(SUM(cd.pago_total), 0) AS pendiente, COALESCE(SUM(cd.aporte_capital), 0) AS capital
      FROM "CuotasDetalle" cd WHERE UPPER(COALESCE(cd.estado, '')) NOT IN ('PAGADO', 'PAGADA')
        AND COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) >= '${P}'`);
    expect(n(t.deudaPendiente)).toBe(n(Number(pendiente)));
    expect(n(t.cupoUtilizado)).toBe(n(Number(capital)));
    expect(n(t.cupoTotal)).toBe('10000000');
    expect(t.porcentajeCupo).toBeCloseTo((Number(capital) / 10000000) * 100, 1);
    expect(t.deudaPendiente.greaterThanOrEqualTo(t.pagoDelMes)).toBe(true);

    // corte 15 / límite 5: el extracto de este mes se paga el 5 del mes siguiente
    const v = d.proximosVencimientos.find((x) => x.periodo === P)!;
    expect(v).toBeDefined();
    expect(v.fecha).toBe(`${mesRelativo(1)}-05`);
    expect(v.vencido).toBe(false);
    expect(n(v.monto)).toBe('200000');
    expect(d.proximosVencimientos.every((x) => x.tarjetaId === semilla.tarjetaId)).toBe(true);
  });

  it('las cuotas de meses anteriores sin marcar pagadas no inflan la deuda: se informan aparte', async () => {
    await sembrarCompras();
    await s.prisma.$executeRawUnsafe(`UPDATE "CuotasDetalle" SET estado = 'Pagado'`);
    const limpio = await resumen();
    expect(n(limpio.tarjetas.items[0].vencidoSinRegistrar)).toBe('0');
    expect(n(limpio.tarjetas.totales.deudaPendiente)).toBe('0');

    // la cuota del mes pasado (nevera 1/12 = 100000) queda «Pendiente»: era de un extracto que ya se debió pagar
    await s.prisma.$executeRawUnsafe(`UPDATE "CuotasDetalle" SET estado = 'Pendiente' WHERE periodo_facturacion = '${mesRelativo(-1)}'`);
    const d = await resumen();
    expect(n(d.tarjetas.items[0].vencidoSinRegistrar)).toBe('100000');
    expect(n(d.tarjetas.totales.vencidoSinRegistrar)).toBe('100000');
    expect(n(d.tarjetas.totales.deudaPendiente)).toBe('0'); // no es deuda de este mes en adelante
    // pero sí aparece como vencimiento (el día límite ya pasó)
    expect(d.proximosVencimientos.some((v) => v.periodo === mesRelativo(-1))).toBe(true);
  });

  it('por cobrar: coincide con el estado de cuenta de las personas y lista a los principales deudores', async () => {
    await sembrarCompras();
    const d = await resumen();
    const ec = await s.estadoCuentaPersonas.listar(semilla.userId, P);

    expect(n(d.porCobrar.deudaTotal)).toBe(n(ec.totales.deudaTotal));
    expect(n(d.porCobrar.pagoDelMes)).toBe('150000');
    expect(n(d.porCobrar.aPagarAhora)).toBe('200000');
    expect(d.porCobrar.topDeudores).toHaveLength(1);
    expect(d.porCobrar.topDeudores[0]).toMatchObject({ personaId: semilla.andresId, nombre: 'Andrés' });
    expect(n(d.porCobrar.topDeudores[0].deudaTotal)).toBe('900000');
  });

  it('patrimonio = liquidez + por cobrar − deuda de tarjetas', async () => {
    await sembrarCompras();
    const d = await resumen();
    const esperado = d.liquidez.total.plus(d.porCobrar.deudaTotal).minus(d.tarjetas.totales.deudaPendiente);
    expect(n(d.liquidez.patrimonioNeto.valor)).toBe(n(esperado));
    expect(n(d.liquidez.patrimonioNeto.deudaTarjetas)).toBe(n(d.tarjetas.totales.deudaPendiente));
  });

  it('alertas: cuenta lo que espera una acción', async () => {
    await s.transacciones.create({ tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Taxi', montoOriginal: 45000, estado: 'PENDIENTE_REVISION' } as any, semilla.userId);
    const d = await resumen();
    expect(d.alertas.movimientosPorRevisar).toBe(1);
  });

  it('valida el periodo', async () => {
    await expect(s.dashboard.resumen(semilla.userId, '2026-13')).rejects.toBeDefined();
  });
});
