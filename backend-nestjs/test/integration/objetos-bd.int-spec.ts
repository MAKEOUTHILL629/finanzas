/* eslint-disable @typescript-eslint/no-explicit-any */
import { crearServicios, dec, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Guardas de los triggers de `sql/001` frente a lo que escribe la app Scala (filas sin `owner_user_id`, estados
 * heredados) y frente a las restricciones reales de la BD (`monto > 0`, `owner_user_id NOT NULL`).
 */
describeDb('Integración BD — guardas de triggers y vistas (sql/001)', () => {
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

  const ledger = () => s.prisma.movimientosDeudaPersona.findMany({ orderBy: { id: 'asc' } });
  const prestamoDirecto = (extra: Record<string, unknown> = {}) =>
    s.prisma.prestamos.create({
      data: {
        owner_user_id: semilla.userId,
        responsable: BigInt(semilla.andresId),
        valor_prestado: '90000',
        saldo_pendiente: '90000',
        concepto: 'Mercado',
        fecha_prestamo: new Date(`${mes}-05T00:00:00Z`),
        estado: 'Pendiente',
        direccion_prestamo: 'POR_COBRAR',
        metodo: 'Nequi',
        ...extra,
      } as any,
    });

  describe('Trigger 4 (Prestamos → sub-ledger)', () => {
    it('un préstamo sin dueño (lo escribe Scala) NO falla y no genera asientos', async () => {
      await prestamoDirecto({ owner_user_id: null });
      expect(await s.prisma.prestamos.count()).toBe(1);
      expect(await ledger()).toHaveLength(0);
    });

    it('un préstamo sin responsable tampoco falla', async () => {
      await prestamoDirecto({ responsable: null });
      expect(await ledger()).toHaveLength(0);
    });

    it('pagar un préstamo histórico SIN cargo en el sub-ledger no crea un abono huérfano', async () => {
      const p = await prestamoDirecto();
      await s.prisma.movimientosDeudaPersona.deleteMany(); // como si el backfill aún no hubiera cargado el histórico
      await s.prisma.prestamos.update({ where: { id: p.id }, data: { estado: 'Pagado' } });
      expect(await ledger()).toHaveLength(0);
    });

    it('pagar un préstamo con cargo registra UN abono por el saldo; con saldo 0 no abona nada (antes violaba monto > 0)', async () => {
      const p = await prestamoDirecto();
      await s.prisma.prestamos.update({ where: { id: p.id }, data: { estado: 'Pagado' } });
      expect((await ledger()).map((m) => [m.tipo_movimiento, m.signo, dec(m.monto)])).toEqual([
        ['CARGO_PRESTAMO_DIRECTO', 1, '90000'],
        ['ABONO_PAGO_RECIBIDO', -1, '90000'],
      ]);

      const q = await prestamoDirecto({ concepto: 'Otro' });
      await s.prisma.prestamos.update({ where: { id: q.id }, data: { estado: 'Pagado', saldo_pendiente: '0' } }); // mismo UPDATE (caso D17)
      expect(await ledger()).toHaveLength(3); // solo el cargo de q, sin abono de 0
    });

    it('un préstamo con valor 0 no inserta un cargo de 0 (monto > 0)', async () => {
      await prestamoDirecto({ valor_prestado: '0', saldo_pendiente: '0' });
      expect(await ledger()).toHaveLength(0);
    });

    it('anular un préstamo anula sus asientos del sub-ledger y deja de contar en el estado de cuenta', async () => {
      const p = await prestamoDirecto();
      await s.prisma.prestamos.update({ where: { id: p.id }, data: { estado: 'Anulado' } });
      expect((await ledger()).map((m) => m.estado)).toEqual(['ANULADO']);
      const fila = (await s.subledger.estadoCuenta(mes, semilla.userId)).find((f) => Number(f.persona_id) === semilla.andresId) as any;
      expect(dec(fila.prestamos_mes)).toBe('0');
      expect(dec(fila.saldo_total_acumulado)).toBe('0');
    });

    it('un préstamo nacido Pagado inserta cargo y abono (migración histórica)', async () => {
      await prestamoDirecto({ estado: 'Pagado' });
      expect((await ledger()).map((m) => m.signo)).toEqual([1, -1]);
    });
  });

  describe('Trigger 6 (responsable de una compra → cuotas del tercero)', () => {
    it('una compra sin dueño (Scala) con responsable NO falla ni genera asientos', async () => {
      const compra = await s.compras.save(
        { concepto: 'Sin dueño', valorCompra: 120000, fechaCompra: `${mes}-05`, numeroCuotas: 3, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId },
        semilla.userId,
      );
      await s.prisma.comprasCredito.update({ where: { id: BigInt(compra) }, data: { owner_user_id: null } });
      await s.prisma.responsablesComprasCredito.create({
        data: { persona: BigInt(semilla.andresId), compra_credito: BigInt(compra), porcentaje_pago: '50', cantidad_cuotas: 3, cantidad_pago: '0' } as any,
      });
      expect(await ledger()).toHaveLength(0);
    });
  });

  describe('Trigger 5 (CrucesDeuda) — ahora con estado CONFIRMADO', () => {
    it('el par contable queda CONFIRMADO y cuenta en el saldo acumulado (la versión anterior lo dejaba en NULL)', async () => {
      await s.subledger.crearCruce({ personaQueAbonaId: semilla.papaId, personaQueAsumeDeudaId: semilla.andresId, monto: 70000, concepto: 'x' } as any, semilla.userId);
      expect((await ledger()).map((m) => m.estado)).toEqual(['CONFIRMADO', 'CONFIRMADO']);
      const fila = (await s.subledger.estadoCuenta(mes, semilla.userId)).find((f) => Number(f.persona_id) === semilla.andresId) as any;
      expect(dec(fila.saldo_total_acumulado)).toBe('70000');
    });
  });

  describe('Trigger 1 y Trigger 2', () => {
    it('Trigger 2: ingreso confirmado suma, anular revierte y borrar revierte lo vigente', async () => {
      const tx = await s.prisma.transacciones.create({
        data: { owner_user_id: semilla.userId, tipo_transaccion: 'INGRESO', cuenta_destino_id: BigInt(semilla.nequiId), fecha_transaccion: new Date(), concepto: 'x', moneda_original: 'COP', monto_original: '50000', tasa_cambio: '1', monto_cop: '50000', origen_registro: 'MANUAL', estado: 'CONFIRMADO' },
      });
      const saldo = async () => dec((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(semilla.nequiId) } })).saldo_actual);
      expect(await saldo()).toBe('50000');
      await s.prisma.transacciones.update({ where: { id: tx.id }, data: { estado: 'ANULADO' } });
      expect(await saldo()).toBe('0');
      await s.prisma.transacciones.update({ where: { id: tx.id }, data: { estado: 'CONFIRMADO' } });
      expect(await saldo()).toBe('50000');
      await s.prisma.transacciones.delete({ where: { id: tx.id } });
      expect(await saldo()).toBe('0');
    });

    it('Trigger 1: una cuota sin periodo_facturacion lo toma de la fecha de pago', async () => {
      const compra = await s.compras.save(
        { concepto: 'x', valorCompra: 100000, fechaCompra: `${mes}-05`, numeroCuotas: 1, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId },
        semilla.userId,
      );
      const cuota = await s.prisma.cuotasDetalle.findFirstOrThrow({ where: { compra: BigInt(compra) } });
      await s.prisma.cuotasDetalle.update({ where: { id: cuota.id }, data: { periodo_facturacion: null, fecha_pago: new Date('2027-03-10T00:00:00Z') } });
      expect((await s.prisma.cuotasDetalle.findUniqueOrThrow({ where: { id: cuota.id } })).periodo_facturacion).toBe('2027-03');
    });
  });

  describe('Vistas (sección 4.2)', () => {
    it('vw_ResumenObligacionesMes y vw_AportesDiaResumen existen con la forma del documento', async () => {
      const cols = await s.prisma.$queryRaw<Array<{ view: string; col: string }>>`
        SELECT table_name AS view, column_name AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('vw_ResumenObligacionesMes', 'vw_AportesDiaResumen')`;
      const de = (vista: string) => cols.filter((c) => c.view === vista).map((c) => c.col);
      expect(de('vw_ResumenObligacionesMes')).toEqual(
        expect.arrayContaining(['owner_user_id', 'responsable_principal_nombre', 'estado_calculado', 'cantidad_registros', 'aportado_directo_responsable', 'aportado_por_cruces']),
      );
      expect(de('vw_AportesDiaResumen')).toEqual(expect.arrayContaining(['aporte_dia_id', 'items_count', 'valor_total_dia']));
    });
  });

  describe('Restricciones de sql/002', () => {
    it('CargosRecurrentesPersona: PLAZO_FIJO exige plazo y mes fin; valor > 0; mes con formato YYYY-MM', async () => {
      const base = { owner_user_id: semilla.userId, persona_id: BigInt(semilla.andresId), concepto: 'x', mes_inicio: mes };
      await expect(s.prisma.cargosRecurrentesPersona.create({ data: { ...base, valor_mensual: '10', modalidad_duracion: 'PLAZO_FIJO' } })).rejects.toThrow();
      await expect(s.prisma.cargosRecurrentesPersona.create({ data: { ...base, valor_mensual: '10', numero_meses: 3 } })).rejects.toThrow(); // INDEFINIDO con plazo
      await expect(s.prisma.cargosRecurrentesPersona.create({ data: { ...base, valor_mensual: '0' } })).rejects.toThrow();
      await expect(s.prisma.cargosRecurrentesPersona.create({ data: { ...base, valor_mensual: '10', mes_inicio: '2026-13' } })).rejects.toThrow();
    });

    it('ObligacionesMes: un solo periodo por usuario, tipo y mes; saldo a favor aplicado no negativo', async () => {
      const dato = { owner_user_id: semilla.userId, tipo_obligacion: 'CUOTA_CARRO', responsable_principal_id: BigInt(semilla.papaId), concepto: 'c', periodo: mes, meta_mensual: '100', fecha_inicio: new Date(`${mes}-01T00:00:00Z`) };
      await s.prisma.obligacionesMes.create({ data: dato });
      await expect(s.prisma.obligacionesMes.create({ data: dato })).rejects.toThrow();
      await expect(s.prisma.obligacionesMes.create({ data: { ...dato, periodo: mesRelativo(-1), saldo_a_favor_aplicado: '-1' } })).rejects.toThrow();
    });
  });
});
