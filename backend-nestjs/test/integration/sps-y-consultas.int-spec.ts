/* eslint-disable @typescript-eslint/no-explicit-any */
import { TipoTransaccion } from '../../src/common/enums/finance.enums';
import { crearServicios, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/** Stored procedures (sp_*) y consultas analíticas (7.1–7.4 + legacy de pagos) en PostgreSQL real. */
describeDb('Integración BD — stored procedures y consultas', () => {
  let s: Servicios;
  let semilla: Semilla;
  const mes = mesRelativo(0);

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
  });

  /** Compra de 1.200.000 en 12 cuotas sin interés cuya cuota 1 cae a fin del mes ACTUAL (100.000 por cuota). */
  const compraDelMes = (extra: Record<string, unknown> = {}) =>
    s.compras.save(
      { concepto: 'Nevera', valorCompra: 1200000, fechaCompra: `${mes}-05`, numeroCuotas: 12, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId, ...extra },
      semilla.userId,
    );
  const responsable = (compraId: number, persona: number, pct: number) =>
    s.responsables.create({ persona, porcentajePago: pct, cantidadPago: 0, cantidadCuotas: 12, compraCredito: compraId }, semilla.userId);
  const saldo = async (cuentaId: number) =>
    (await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(cuentaId) } })).saldo_actual.toString();

  describe('sp_pagar_extracto_tarjeta', () => {
    it('crea la transacción PAGO_TARJETA, descuenta el saldo (Trigger 2) y marca las cuotas del periodo PAGADA', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 50);

      const r = await s.tarjetas.pagarExtracto(semilla.tarjetaId, semilla.userId, { cuentaOrigenId: semilla.bancolombiaId, periodo: mes, montoPagado: 100000 });

      const tx = await s.prisma.transacciones.findUniqueOrThrow({ where: { id: BigInt(r.transaccionId) } });
      expect(tx).toMatchObject({ tipo_transaccion: TipoTransaccion.PAGO_TARJETA, estado: 'CONFIRMADO', origen_registro: 'MANUAL', tarjeta_pagada_id: BigInt(semilla.tarjetaId) });
      expect(tx.monto_cop.toString()).toBe('100000');
      expect(await saldo(semilla.bancolombiaId)).toBe('900000');

      const cuotas = await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } });
      expect(cuotas[0].estado).toBe('PAGADA');
      expect(cuotas[1].estado).not.toBe('PAGADA'); // otros periodos intactos
      // Trigger 8: la cuota pagada confirma el asiento del tercero
      const mov = await s.prisma.movimientosDeudaPersona.findFirstOrThrow({ where: { cuota_detalle_id: cuotas[0].id } });
      expect(mov.estado).toBe('CONFIRMADO');
    });
  });

  describe('sp_registrar_abono_persona', () => {
    it('registra el reembolso: transacción REEMBOLSO_TERCERO + abono -1 + saldo de la cuenta', async () => {
      const r = await s.subledger.abonarPersona(semilla.andresId, { cuentaDestinoId: semilla.nequiId, monto: 350000.5, periodoImputacion: mes, concepto: 'Pago Nequi' }, semilla.userId);

      const mov = await s.prisma.movimientosDeudaPersona.findUniqueOrThrow({ where: { id: BigInt(r.movimientoId) } });
      expect(mov).toMatchObject({ tipo_movimiento: 'ABONO_PAGO_RECIBIDO', signo: -1, estado: 'CONFIRMADO', persona_id: BigInt(semilla.andresId) });
      expect(mov.monto.toString()).toBe('350000.5');
      const tx = await s.prisma.transacciones.findUniqueOrThrow({ where: { id: mov.transaccion_id as bigint } });
      expect(tx).toMatchObject({ tipo_transaccion: TipoTransaccion.REEMBOLSO_TERCERO, cuenta_destino_id: BigInt(semilla.nequiId) });
      expect(await saldo(semilla.nequiId)).toBe('350000.5');
    });

    it('liquidar préstamos de un corte: UN solo abono (el del pago) y el préstamo queda Pagado con saldo 0', async () => {
      await s.prestamos.create({ valorPrestado: 80000, concepto: 'P1', fechaCobro: `${mes}-28`, responsable: semilla.andresId, estado: 'Pendiente', comentarios: '' } as any, semilla.userId);

      const r = await s.subledger.abonarPersona(
        semilla.andresId,
        { cuentaDestinoId: semilla.nequiId, monto: 80000, periodoImputacion: mes, concepto: 'Pago del corte', liquidarPrestamosCorteId: semilla.corteId },
        semilla.userId,
      );

      // `sp_registrar_abono_persona` activa `app.omitir_abono_prestamo`: el Trigger 4 no abona otra vez cada préstamo
      // (antes fallaba con `monto > 0`, D17) y el pago de la persona queda anotado una sola vez.
      expect(r.movimientoId).toBeGreaterThan(0);
      const prestamo = await s.prisma.prestamos.findFirstOrThrow();
      expect(prestamo.estado).toBe('Pagado');
      expect(prestamo.saldo_pendiente?.toString()).toBe('0');

      const movs = await s.prisma.movimientosDeudaPersona.findMany({ where: { persona_id: BigInt(semilla.andresId) }, orderBy: { id: 'asc' } });
      expect(movs.map((m) => [m.tipo_movimiento, m.signo, m.monto.toString()])).toEqual([
        ['CARGO_PRESTAMO_DIRECTO', 1, '80000'],
        ['ABONO_PAGO_RECIBIDO', -1, '80000'],
      ]);
      expect(await s.prisma.transacciones.count()).toBe(1);
      expect(await saldo(semilla.nequiId)).toBe('80000');
    });
  });

  describe('sp_actualizar_trm_compra_usd', () => {
    it('recalcula cuotas y el Trigger 8 actualiza lo que deben los responsables', async () => {
      const id = await s.compras.save(
        { concepto: 'Amazon', fechaCompra: `${mes}-05`, numeroCuotas: 3, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId, monedaOriginal: 'USD', valorMonedaOriginal: 100, tasaCambioAplicada: 4200 },
        semilla.userId,
      );
      await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 3, compraCredito: id }, semilla.userId);
      const movsAntes = await s.prisma.movimientosDeudaPersona.findMany({ orderBy: { id: 'asc' } });
      expect(movsAntes.map((m) => m.monto.toString())).toEqual(['70000', '70000', '70000']);

      const compra = await s.compras.confirmarTrm(id, semilla.userId, 4150, true);

      expect(compra).toMatchObject({ valorCompra: 415000, tasaCambioAplicada: 4150, trmConfirmada: true, valorMonedaOriginal: 100 });
      const cuotas = await s.cuotas.listByCompra(id, semilla.userId);
      expect(cuotas.map((c) => c.pagoTotal)).toEqual([138333.33, 138333.33, 138333.33]); // 140000 × 4150/4200
      const movsDespues = await s.prisma.movimientosDeudaPersona.findMany({ orderBy: { id: 'asc' } });
      expect(movsDespues.map((m) => m.id)).toEqual(movsAntes.map((m) => m.id));
      expect(movsDespues.map((m) => m.monto.toString())).toEqual(['69166.67', '69166.67', '69166.67']); // ROUND(138333.33 × 50 %, 2)
    });

    it('una compra en COP no se puede "confirmar TRM"', async () => {
      const id = await compraDelMes();
      await expect(s.compras.confirmarTrm(id, semilla.userId, 4150)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('consultas legacy de pagos', () => {
    it('/api/tarjetas/pagos, /pagos/:id, /balance y /api/pagos/personas', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 50);
      await responsable(id, semilla.papaId, 25);

      const pagos = await s.pagos.calcularPagoTarjetasCredito(semilla.userId);
      expect(pagos).toHaveLength(12);
      expect(pagos[0]).toMatchObject({ valorPago: 100000, tarjeta: semilla.tarjetaId });

      const [anio, m] = mes.split('-').map(Number);
      const detalle = await s.pagos.calcularPagoTarjetaCreditoDetalle(semilla.tarjetaId, anio, m, semilla.userId);
      expect(detalle).toHaveLength(1);
      expect(detalle[0]).toMatchObject({ numeroCuota: 1, pagoTotal: 100000, saldoRestante: 1100000, concepto: 'Nevera', numeroCuotasTotal: 12, tarjeta: semilla.tarjetaId });

      const balance = await s.tarjetas.balance(m, anio, semilla.userId);
      expect(balance).toEqual([{ tarjeta: semilla.tarjetaId, franquicia: 'Visa', total_saldo_restante: 1100000 }]);

      const porPersona = await s.consultas.listPagosMensualesPersona(semilla.userId);
      expect(porPersona).toHaveLength(24); // 12 cuotas × 2 responsables
      const andres = porPersona.filter((p) => p.persona === semilla.andresId);
      expect(andres[0].valorPago).toBe(50000);
      expect(andres[0].fecha).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);

      const det = await s.consultas.listPagosMensualesPersonaDetalle(semilla.papaId, m, anio, semilla.userId);
      expect(det).toHaveLength(1);
      expect(det[0]).toMatchObject({ persona: semilla.papaId, porcentaje: 25, valorPagoCuota: 100000, valorPagoResponsable: 25000, cantidadCuotaTotal: 12, numeroCuota: 1, concepto: 'Nevera' });
    });

    it('exclusiones heredadas: /tarjetas/pagos omite cuotas "Ajuste Interes"; /pagos/personas/:id omite conceptos "Ajuste de Interes"', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 50);
      await s.compras.ajusteInteresTarjetaCredito(semilla.tarjetaId, semilla.userId);
      expect(await s.pagos.calcularPagoTarjetasCredito(semilla.userId)).toEqual([]);

      const id2 = await compraDelMes({ concepto: 'Cuota - Ajuste de Interes' });
      await responsable(id2, semilla.andresId, 50);
      const [anio, m] = mes.split('-').map(Number);
      const detalle = await s.consultas.listPagosMensualesPersonaDetalle(semilla.andresId, m, anio, semilla.userId);
      // Igual que el legacy: el detalle por persona solo filtra por concepto (no por el estado de la compra/cuota)
      expect(detalle.map((d) => d.concepto)).toEqual(['Nevera']);
      expect(detalle[0].estado).toBe('Ajuste Interes');
    });
  });

  describe('consultas 7.1 – 7.4', () => {
    it('7.1 estado de cuenta + 7.2 extracto de una persona', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 50);
      await s.prestamos.create({ valorPrestado: 200000, concepto: 'P', fechaCobro: `${mes}-28`, responsable: semilla.andresId, estado: 'Pendiente', comentarios: '' } as any, semilla.userId);
      await s.subledger.abonarPersona(semilla.andresId, { cuentaDestinoId: semilla.nequiId, monto: 30000, periodoImputacion: mes, concepto: 'Abono' }, semilla.userId);

      const estado = await s.subledger.estadoCuenta(mes, semilla.userId);
      const andres = estado.find((e) => Number(e.persona_id) === semilla.andresId);
      expect(andres?.cuotas_tc_mes.toString()).toBe('50000');
      expect(andres?.prestamos_mes.toString()).toBe('200000');
      expect(andres?.abonos_recibidos_mes.toString()).toBe('30000');
      expect(andres?.saldo_neto_mes.toString()).toBe('220000'); // 50000 + 200000 − 30000
      // acumulado confirmado: cuota 1 (CONFIRMADO) + préstamo − abono; las cuotas futuras PROYECTADAS no cuentan
      expect(andres?.saldo_total_acumulado.toString()).toBe('220000');
      expect(estado[0].nombre).toBe('Andrés'); // ordenado por saldo acumulado desc
      expect(estado).toHaveLength(3); // incluye personas sin movimientos

      const extracto = await s.subledger.extracto(semilla.andresId, mes, semilla.userId);
      expect(extracto.map((e) => e.tipo_movimiento).sort()).toEqual(['ABONO_PAGO_RECIBIDO', 'CARGO_CUOTA_TC', 'CARGO_PRESTAMO_DIRECTO']);
      expect(extracto.find((e) => e.signo === -1)?.impacto_saldo.toString()).toBe('-30000');
    });

    it('7.3 resumen por tarjeta: lo tuyo vs. lo de terceros (un tercero)', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 40);
      await responsable(id, semilla.yoId, 60);

      const [fila] = await s.tarjetas.resumenMensual(mes, semilla.userId);
      expect(Number(fila.tarjeta_id)).toBe(semilla.tarjetaId);
      expect(fila.periodo_facturacion).toBe(mes);
      expect(Number(fila.total_cuotas_mes)).toBe(1);
      expect(fila.total_extracto_cop.toString()).toBe('100000');
      expect(fila.total_responsabilidad_terceros.toString()).toBe('40000');
      expect(fila.total_propio.toString()).toBe('60000');
      expect(fila.componente_en_usd.toString()).toBe('0');
      expect(fila.todas_trm_confirmadas).toBe(true);
    });

    it('7.3 con DOS terceros responsables: el total del extracto no se duplica', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 30);
      await responsable(id, semilla.papaId, 20);

      const [fila] = await s.tarjetas.resumenMensual(mes, semilla.userId);
      expect(fila.total_extracto_cop.toString()).toBe('100000'); // el JOIN del documento daba 200000
      expect(fila.total_responsabilidad_terceros.toString()).toBe('50000');
      expect(fila.total_propio.toString()).toBe('50000');
      expect(Number(fila.total_cuotas_mes)).toBe(1);
    });

    it('7.3 por tercero: respeta cuántas cuotas le tocan a cada responsable y detalla cuánto es de cada uno', async () => {
      const id = await s.compras.save(
        { concepto: 'Nevera', valorCompra: 1200000, fechaCompra: `${mes}-10`, numeroCuotas: 12, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId },
        semilla.userId,
      );
      // Andrés 50 % pero solo las 3 primeras cuotas; Papá 20 % las 12; el propietario 30 %
      await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 3, compraCredito: id }, semilla.userId);
      await s.responsables.create({ persona: semilla.papaId, porcentajePago: 20, cantidadPago: 240000, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
      await s.responsables.create({ persona: semilla.yoId, porcentajePago: 30, cantidadPago: 360000, cantidadCuotas: 12, compraCredito: id }, semilla.userId);

      const [cuota1] = await s.tarjetas.resumenMensual(mes, semilla.userId);
      expect(cuota1.total_extracto_cop.toString()).toBe('100000');
      expect(cuota1.total_responsabilidad_terceros.toString()).toBe('70000'); // cuota 1: Andrés 50 % + Papá 20 %
      expect(cuota1.total_propio.toString()).toBe('30000');
      expect(cuota1.terceros.map((t) => [Number(t.personaId), t.monto.toString()])).toEqual([
        [semilla.andresId, '50000'],
        [semilla.papaId, '20000'],
      ]);

      // 4 meses después Andrés ya terminó sus 3 cuotas: solo queda Papá
      const [cuota4] = await s.tarjetas.resumenMensual(mesRelativo(3), semilla.userId);
      expect(cuota4.total_responsabilidad_terceros.toString()).toBe('20000');
      expect(cuota4.total_propio.toString()).toBe('80000');
      expect(cuota4.terceros.map((t) => Number(t.personaId))).toEqual([semilla.papaId]);
    });

    it('7.3 con compra en USD: componente_en_usd y TRM sin confirmar', async () => {
      await s.compras.save(
        { concepto: 'Amazon', fechaCompra: `${mes}-05`, numeroCuotas: 1, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId, monedaOriginal: 'USD', valorMonedaOriginal: 100, tasaCambioAplicada: 4200 },
        semilla.userId,
      );
      const [fila] = await s.tarjetas.resumenMensual(mes, semilla.userId);
      expect(fila.total_extracto_cop.toString()).toBe('420000');
      expect(fila.componente_en_usd.toString()).toBe('100');
      expect(fila.todas_trm_confirmadas).toBe(false);
    });

    it('7.3 sin Persona enlazada al usuario: todos los responsables cuentan como terceros', async () => {
      await s.prisma.personas.update({ where: { id: BigInt(semilla.yoId) }, data: { linked_user_id: null } });
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 25);
      const [fila] = await s.tarjetas.resumenMensual(mes, semilla.userId);
      expect(fila.total_responsabilidad_terceros.toString()).toBe('25000');
    });

    it('7.4 flujo de caja del mes', async () => {
      const id = await compraDelMes();
      await responsable(id, semilla.andresId, 50);
      await s.transacciones.create({ tipoTransaccion: TipoTransaccion.INGRESO, cuentaDestinoId: semilla.bancolombiaId, concepto: 'Nómina', montoOriginal: 5000000 }, semilla.userId);
      await s.transacciones.create({ tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Mercado', montoOriginal: 200000 }, semilla.userId);
      // un REEMBOLSO_TERCERO no cuenta como ingreso del mes
      await s.transacciones.create({ tipoTransaccion: TipoTransaccion.REEMBOLSO_TERCERO, cuentaDestinoId: semilla.bancolombiaId, concepto: 'Pago Andrés', montoOriginal: 777 }, semilla.userId);
      const plantilla = await s.recurrentes.createPlantilla({ nombre: 'Internet', montoBaseEstimado: 95000 }, semilla.userId);
      await s.recurrentes.proyectar(mes, semilla.userId);
      expect(plantilla.nombre).toBe('Internet');

      const f = await s.subledger.flujoCaja(mes, semilla.userId);
      expect(f.total_ingresos.toString()).toBe('5000000');
      expect(f.total_egresos_directos.toString()).toBe('200000');
      expect(f.total_tarjetas.toString()).toBe('100000');
      expect(f.total_esperado_recurrentes.toString()).toBe('95000');
      expect(f.total_por_cobrar_terceros.toString()).toBe('50000'); // cargo de Andrés (50 % de la cuota)
      expect(f.desembolso_bruto_mes.toString()).toBe('395000');
      expect(f.gasto_neto_real_tuyo.toString()).toBe('345000');
      expect(f.flujo_caja_libre_estimado.toString()).toBe('4655000');
    });

    it('7.4 sin datos devuelve ceros (una fila)', async () => {
      const f = await s.subledger.flujoCaja(mesRelativo(-20), semilla.userId);
      expect(f.total_ingresos.toString()).toBe('0');
      expect(f.flujo_caja_libre_estimado.toString()).toBe('0');
    });
  });
});
