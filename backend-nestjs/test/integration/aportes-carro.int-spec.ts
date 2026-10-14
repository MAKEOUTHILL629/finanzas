/* eslint-disable @typescript-eslint/no-explicit-any */
import { crearServicios, dec, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Aportes diarios del carro, saldo a favor, cruces de cuentas, recurrentes por persona y liquidación mensual contra
 * PostgreSQL real (esquema + `sql/*.sql`: triggers 1–8 y SPs). NestJS solo dispara los triggers; los asientos del
 * sub-ledger los crea la base de datos.
 */
describeDb('Integración BD — aportes del carro, cruces, recurrentes por persona y liquidación', () => {
  let s: Servicios;
  let semilla: Semilla;
  let efectivoId: number;
  const mes = mesRelativo(0);
  const anterior = mesRelativo(-1);
  const siguiente = mesRelativo(1);

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
    const efectivo = await s.prisma.cuentasFinancieras.create({
      data: { owner_user_id: semilla.userId, nombre: 'Efectivo', tipo_cuenta: 'EFECTIVO', saldo_actual: '0' },
    });
    efectivoId = Number(efectivo.id);
  });

  const saldo = async (cuentaId: number) =>
    dec((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(cuentaId) } })).saldo_actual);
  const movimientos = (personaId: number) =>
    s.prisma.movimientosDeudaPersona.findMany({ where: { persona_id: BigInt(personaId) }, orderBy: { id: 'asc' } });
  const cuota = (periodo: string, valor: string | number = 1000000) =>
    s.aportesCarro.guardarPeriodo({ periodo, valorCuota: valor, responsablePrincipalId: semilla.papaId } as any, semilla.userId);
  const aporte = (extra: Record<string, unknown>) => s.aportesCarro.registrarAporteDiario(extra as any, semilla.userId);
  const periodoVista = async (periodo: string) => {
    const resumen = await s.aportesCarro.resumenCarro(semilla.userId);
    return resumen.periodos.find((p) => p.periodo === periodo) as NonNullable<(typeof resumen.periodos)[number]>;
  };

  describe('Aporte diario con desglose (efectivo + cruce de cuentas)', () => {
    async function aporteConCruce() {
      await cuota(anterior);
      return aporte({
        fecha: `${mes}-14`,
        periodo: anterior,
        notas: 'Entrega de este mes para la cuota anterior',
        detalles: [
          { valor: 600000, metodo: 'EFECTIVO', personaId: semilla.papaId },
          { valor: '100000.50', metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId, comentarios: 'Andrés le debía a mi papá lo de un arreglo' },
        ],
      });
    }

    it('suma a la cuota, ingresa el efectivo a la cuenta y le carga la deuda a Andrés (Triggers 2, 3 y 4)', async () => {
      const r = await aporteConCruce();

      // El aporte hecho en el mes actual abona al periodo anterior (como en AppSheet)
      expect(r.periodo).toMatchObject({ periodo: anterior, estado: 'PARCIAL', cantidadAportes: 1 });
      expect(dec(r.periodo.montoAbonado)).toBe('700000.5');
      expect(dec(r.periodo.saldoPendiente)).toBe('299999.5');
      expect(dec(r.periodo.aportadoPorCruces)).toBe('100000.5');
      expect(dec(r.periodo.aportadoDirecto)).toBe('600000');
      expect(dec(r.aporteDiario.valorTotal)).toBe('700000.5');
      expect(r).toMatchObject({ transaccionesCreadas: 1, crucesGenerados: 1 });

      // Efectivo → INGRESO confirmado → Trigger 2 mueve el saldo de la cuenta
      expect(await saldo(efectivoId)).toBe('600000');
      const efectivo = r.aporteDiario.detalles.find((d) => d.metodoCanonico === 'EFECTIVO') as any;
      expect(efectivo).toMatchObject({ cuentaNombre: 'Efectivo', esCruce: false });
      const tx = await s.prisma.transacciones.findUniqueOrThrow({ where: { id: efectivo.transaccionId } });
      expect(tx).toMatchObject({ tipo_transaccion: 'INGRESO', estado: 'CONFIRMADO', cuenta_destino_id: BigInt(efectivoId) });

      // Cruce → Trigger 3: préstamo POR_COBRAR a Andrés + 2 aprobaciones, enlazado al aporte que lo originó
      const cruce = r.aporteDiario.detalles.find((d) => d.esCruce) as any;
      const prestamo = await s.prisma.prestamos.findFirstOrThrow();
      expect(prestamo).toMatchObject({ responsable: BigInt(semilla.andresId), direccion_prestamo: 'POR_COBRAR', estado: 'Pendiente', origen_cruce_aporte_id: cruce.id });
      expect(dec(prestamo.valor_prestado)).toBe('100000.5');
      expect(cruce.prestamoCruceGeneradoId).toBe(prestamo.id);
      expect(await s.prisma.aprobacionesPrestamos.count({ where: { prestamo_id: prestamo.id } })).toBe(2);

      // Trigger 4: el préstamo es un cargo en el estado de cuenta de Andrés, en el mes de la FECHA del aporte
      const movs = await movimientos(semilla.andresId);
      expect(movs).toHaveLength(1);
      expect(movs[0]).toMatchObject({ tipo_movimiento: 'CARGO_CRUCE_DEUDA', signo: 1, estado: 'CONFIRMADO', periodo_imputacion: mes });
      expect(dec(movs[0].monto)).toBe('100000.5');
      expect(await movimientos(semilla.papaId)).toHaveLength(0); // papá no debe nada: sus aportes solo cubren su cuota
    });

    it('el efectivo sin cuenta indicada usa la cuenta EFECTIVO por defecto; sin ninguna, solo se registra el aporte', async () => {
      await cuota(anterior);
      await s.prisma.cuentasFinancieras.update({ where: { id: BigInt(efectivoId) }, data: { is_active: false } });
      const r = await aporte({ fecha: `${mes}-02`, periodo: anterior, detalles: [{ valor: 50000, metodo: 'EFECTIVO', personaId: semilla.papaId }] });
      expect(r.transaccionesCreadas).toBe(0);
      expect(dec(r.periodo.montoAbonado)).toBe('50000');
      expect(await s.prisma.transacciones.count()).toBe(0);
    });

    it('un mes sin periodo se crea con la cuota y el responsable del periodo base', async () => {
      await cuota(anterior, '1400000');
      const r = await aporte({ fecha: `${mes}-02`, detalles: [{ valor: 100000, metodo: 'TRANSFERENCIA', personaId: semilla.papaId, cuentaFinancieraId: semilla.bancolombiaId }] });

      expect(r.periodo).toMatchObject({ periodo: mes, concepto: expect.any(String), estado: 'PARCIAL' });
      expect(dec(r.periodo.valorCuotaObjetivo)).toBe('1400000');
      expect(Number(r.periodo.responsable.id)).toBe(semilla.papaId);
      expect(await saldo(semilla.bancolombiaId)).toBe('1100000'); // 1.000.000 iniciales + 100.000 de la transferencia
    });

    it('sin ningún periodo previo no se puede inferir la cuota: 400 con instrucción', async () => {
      await expect(aporte({ fecha: `${mes}-02`, detalles: [{ valor: 1, metodo: 'EFECTIVO', personaId: semilla.papaId }] })).rejects.toMatchObject({ status: 400 });
    });

    it('reglas método ↔ persona: efectivo a nombre de un tercero, cuenta con cruce y saldo a favor inexistente fallan sin guardar nada', async () => {
      await cuota(anterior);
      const base = { fecha: `${mes}-02`, periodo: anterior };
      await expect(aporte({ ...base, detalles: [{ valor: 1000, metodo: 'EFECTIVO', personaId: semilla.andresId }] })).rejects.toMatchObject({ status: 400 });
      await expect(
        aporte({ ...base, detalles: [{ valor: 1000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId, cuentaFinancieraId: efectivoId }] }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(aporte({ ...base, detalles: [{ valor: 1000, metodo: 'SALDO_A_FAVOR', personaId: semilla.papaId }] })).rejects.toMatchObject({ status: 400 });
      // todo en una transacción: ni el día, ni el cruce, ni el ingreso
      expect(await s.prisma.aportesDia.count()).toBe(0);
      expect(await s.prisma.prestamos.count()).toBe(0);
      expect(await s.prisma.transacciones.count()).toBe(0);
    });

    it('si una línea falla, las anteriores del mismo día se revierten (atomicidad)', async () => {
      await cuota(anterior);
      await expect(
        aporte({
          fecha: `${mes}-02`,
          periodo: anterior,
          detalles: [{ valor: 70000, metodo: 'EFECTIVO', personaId: semilla.papaId }, { valor: 1000, metodo: 'EFECTIVO', personaId: 9999 }],
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await s.prisma.aportesDetalle.count()).toBe(0);
      expect(await saldo(efectivoId)).toBe('0');
    });

    it('un cruce con papá como persona (caso especial) suma a la cuota sin cargar a nadie', async () => {
      await cuota(anterior);
      const r = await aporte({ fecha: `${mes}-02`, periodo: anterior, detalles: [{ valor: 80000, metodo: 'CRUCE_CUENTAS', personaId: semilla.papaId }] });
      expect(dec(r.periodo.montoAbonado)).toBe('80000');
      expect(await s.prisma.prestamos.count()).toBe(0);
      expect(await s.prisma.movimientosDeudaPersona.count()).toBe(0);
    });
  });

  describe('Saldo a favor (excedente)', () => {
    async function conExcedente() {
      const p = await cuota(anterior);
      await aporte({ fecha: `${mes}-03`, periodo: anterior, detalles: [{ valor: 1200000, metodo: 'EFECTIVO', personaId: semilla.papaId }] });
      return p.periodo.id as bigint;
    }

    it('calcula el saldo a favor exacto cuando los aportes superan la cuota', async () => {
      await conExcedente();
      const p = await periodoVista(anterior);
      expect(p.estado).toBe('CON_SALDO_A_FAVOR');
      expect(dec(p.saldoAFavorGenerado)).toBe('200000');
      expect(dec(p.saldoAFavorDisponible)).toBe('200000');
      expect(dec(p.saldoPendiente)).toBe('0');
      const resumen = await s.aportesCarro.resumenCarro(semilla.userId);
      expect(dec(resumen.saldoAFavorDisponibleGlobal)).toBe('200000');
    });

    it('trasladar al mes siguiente: crea un aporte SALDO_A_FAVOR con trazabilidad y descuenta lo disponible', async () => {
      const id = Number(await conExcedente());
      const r = await s.aportesCarro.aplicarExcedente(id, { destino: 'SIGUIENTE_MES', valor: 150000 } as any, semilla.userId);

      expect(dec(r.valorAplicado)).toBe('150000');
      expect(r.periodoDestino).toMatchObject({ periodo: mes, estado: 'PARCIAL' }); // se creó con la cuota del mes anterior
      expect(dec(r.periodoDestino?.montoAbonado)).toBe('150000');
      expect(r.periodo).toMatchObject({ periodo: anterior, estado: 'CON_SALDO_A_FAVOR' });
      expect(dec(r.periodo.saldoAFavorAplicado)).toBe('150000');
      expect(dec(r.periodo.saldoAFavorDisponible)).toBe('50000');

      const detalle = await s.prisma.aportesDetalle.findFirstOrThrow({ where: { metodo: 'SALDO_A_FAVOR' } });
      expect(detalle).toMatchObject({ persona_id: BigInt(semilla.papaId), origen_obligacion_mes_id: BigInt(id) });
      expect(await s.prisma.transacciones.count()).toBe(1); // solo el efectivo original: el traslado no mueve dinero
      expect(await s.prisma.prestamos.count()).toBe(0);
    });

    it('cruzar contra el estado de cuenta del responsable: abono en su sub-ledger; con todo aplicado el periodo queda COMPLETADO', async () => {
      const id = Number(await conExcedente());
      await s.aportesCarro.aplicarExcedente(id, { destino: 'SIGUIENTE_MES', valor: 150000 } as any, semilla.userId);
      const r = await s.aportesCarro.aplicarExcedente(id, { destino: 'ESTADO_CUENTA', periodoImputacion: mes } as any, semilla.userId); // el resto: 50.000

      expect(dec(r.valorAplicado)).toBe('50000');
      expect(r.periodo).toMatchObject({ estado: 'COMPLETADO' });
      expect(dec(r.periodo.saldoAFavorDisponible)).toBe('0');
      const movs = await movimientos(semilla.papaId);
      expect(movs).toHaveLength(1);
      expect(movs[0]).toMatchObject({ tipo_movimiento: 'ABONO_SALDO_FAVOR_CARRO', signo: -1, estado: 'CONFIRMADO', periodo_imputacion: mes, obligacion_mes_id: BigInt(id) });
      expect(dec(movs[0].monto)).toBe('50000');
    });

    it('no se puede aplicar más de lo disponible ni cuando no hay excedente', async () => {
      const id = Number(await conExcedente());
      await expect(s.aportesCarro.aplicarExcedente(id, { destino: 'SIGUIENTE_MES', valor: 200000.01 } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await s.aportesCarro.aplicarExcedente(id, { destino: 'ESTADO_CUENTA' } as any, semilla.userId);
      await expect(s.aportesCarro.aplicarExcedente(id, { destino: 'ESTADO_CUENTA' } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
    });

    it('borrar el aporte que trasladó el saldo lo devuelve al periodo de origen', async () => {
      const id = Number(await conExcedente());
      const r = await s.aportesCarro.aplicarExcedente(id, { destino: 'SIGUIENTE_MES', valor: 120000 } as any, semilla.userId);
      const dias = await s.prisma.aportesDia.findMany({ where: { obligacion_mes_id: r.periodoDestino?.id as bigint } });

      await s.aportesCarro.eliminarAporteDiario(Number(dias[0].id), semilla.userId);

      const p = await periodoVista(anterior);
      expect(dec(p.saldoAFavorAplicado)).toBe('0');
      expect(dec(p.saldoAFavorDisponible)).toBe('200000');
    });
  });

  describe('Editar y eliminar un aporte diario (reversión atómica)', () => {
    it('eliminar: anula el cruce y el cargo de Andrés, anula el ingreso y revierte el saldo de la cuenta', async () => {
      await cuota(anterior);
      const creado = await aporte({
        fecha: `${mes}-14`,
        periodo: anterior,
        detalles: [
          { valor: 600000, metodo: 'EFECTIVO', personaId: semilla.papaId },
          { valor: 100000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId },
        ],
      });
      expect(await saldo(efectivoId)).toBe('600000');

      const r = await s.aportesCarro.eliminarAporteDiario(Number(creado.aporteDiario.id), semilla.userId);

      expect(r).toMatchObject({ eliminado: true, detallesEliminados: 2, crucesAnulados: 1, transaccionesAnuladas: 1 });
      expect(await s.prisma.aportesDia.count()).toBe(0);
      expect(await s.prisma.aportesDetalle.count()).toBe(0);
      expect(await saldo(efectivoId)).toBe('0'); // Trigger 2 revirtió el ingreso
      expect((await s.prisma.transacciones.findFirstOrThrow()).estado).toBe('ANULADO');
      expect((await s.prisma.prestamos.findFirstOrThrow()).estado).toBe('Anulado');
      expect((await movimientos(semilla.andresId))[0].estado).toBe('ANULADO'); // Trigger 4: deja de contar
      const ec = (await s.subledger.estadoCuenta(mes, semilla.userId)).find((f) => Number(f.persona_id) === semilla.andresId) as any;
      expect(dec(ec.cruces_asumidos_mes)).toBe('0');
      expect(dec(ec.saldo_neto_mes)).toBe('0');
      expect((await periodoVista(anterior)).estado).toBe('PENDIENTE');
    });

    it('un cruce ya pagado no se puede modificar ni eliminar (409) y no se toca nada', async () => {
      await cuota(anterior);
      const creado = await aporte({ fecha: `${mes}-14`, periodo: anterior, detalles: [{ valor: 100000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId }] });
      const prestamo = await s.prisma.prestamos.findFirstOrThrow();
      await s.prisma.prestamos.update({ where: { id: prestamo.id }, data: { estado: 'Pagado' } });

      await expect(s.aportesCarro.eliminarAporteDiario(Number(creado.aporteDiario.id), semilla.userId)).rejects.toMatchObject({ status: 409 });
      await expect(
        s.aportesCarro.actualizarAporteDiario(
          Number(creado.aporteDiario.id),
          { fecha: `${mes}-14`, detalles: [{ id: Number(creado.aporteDiario.detalles[0].id), valor: 90000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId }] } as any,
          semilla.userId,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await s.prisma.aportesDia.count()).toBe(1);
      expect(await s.prisma.aportesDetalle.count()).toBe(1);
      expect((await s.prisma.prestamos.findFirstOrThrow()).estado).toBe('Pagado');
    });

    it('editar: el detalle sin cambios conserva su transacción; el modificado se rehace (cruce nuevo, anterior anulado)', async () => {
      await cuota(anterior);
      const creado = await aporte({
        fecha: `${mes}-14`,
        periodo: anterior,
        detalles: [
          { valor: 600000, metodo: 'EFECTIVO', personaId: semilla.papaId, comentarios: 'original' },
          { valor: 100000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId },
        ],
      });
      const [dEfectivo, dCruce] = creado.aporteDiario.detalles as any[];

      const r = await s.aportesCarro.actualizarAporteDiario(
        Number(creado.aporteDiario.id),
        {
          fecha: `${mes}-14`,
          notas: 'corregido',
          detalles: [
            { id: Number(dEfectivo.id), valor: 600000, metodo: 'EFECTIVO', personaId: semilla.papaId, comentarios: 'solo cambia el comentario' },
            { id: Number(dCruce.id), valor: 150000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId },
            { valor: 50000, metodo: 'EFECTIVO', personaId: semilla.papaId },
          ],
        } as any,
        semilla.userId,
      );

      const detalles = r.aporteDiario.detalles as any[];
      const conservado = detalles.find((d) => d.id === dEfectivo.id);
      expect(conservado).toMatchObject({ comentarios: 'solo cambia el comentario', transaccionId: dEfectivo.transaccionId });
      expect(detalles.some((d) => d.id === dCruce.id)).toBe(false);
      expect(r.aporteDiario.notas).toBe('corregido');
      expect(dec(r.periodo.montoAbonado)).toBe('800000');

      // cruce rehecho: el préstamo viejo queda Anulado y su asiento ANULADO; el nuevo vale 150.000
      const prestamos = await s.prisma.prestamos.findMany({ orderBy: { id: 'asc' } });
      expect(prestamos.map((p) => [p.estado, dec(p.valor_prestado)])).toEqual([['Anulado', '100000'], ['Pendiente', '150000']]);
      const movs = await movimientos(semilla.andresId);
      expect(movs.map((m) => [m.estado, dec(m.monto)])).toEqual([['ANULADO', '100000'], ['CONFIRMADO', '150000']]);
      // el ingreso original se conservó y el nuevo efectivo suma 50.000
      expect(await saldo(efectivoId)).toBe('650000');
      expect(await s.prisma.transacciones.count({ where: { estado: 'CONFIRMADO' } })).toBe(2);
    });

    it('un detalle con id ajeno al día se rechaza', async () => {
      await cuota(anterior);
      const creado = await aporte({ fecha: `${mes}-14`, periodo: anterior, detalles: [{ valor: 1000, metodo: 'EFECTIVO', personaId: semilla.papaId }] });
      await expect(
        s.aportesCarro.actualizarAporteDiario(
          Number(creado.aporteDiario.id),
          { fecha: `${mes}-14`, detalles: [{ id: 999999, valor: 1000, metodo: 'EFECTIVO', personaId: semilla.papaId }] } as any,
          semilla.userId,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('mover el aporte a otro mes cambia el periodo al que abona', async () => {
      await cuota(anterior);
      await cuota(mes);
      const creado = await aporte({ fecha: `${mes}-14`, periodo: anterior, detalles: [{ valor: 70000, metodo: 'EFECTIVO', personaId: semilla.papaId }] });
      const r = await s.aportesCarro.actualizarAporteDiario(
        Number(creado.aporteDiario.id),
        { fecha: `${mes}-14`, periodo: mes, detalles: [{ id: Number(creado.aporteDiario.detalles[0].id), valor: 70000, metodo: 'EFECTIVO', personaId: semilla.papaId }] } as any,
        semilla.userId,
      );
      expect(r.periodo.periodo).toBe(mes);
      expect(dec((await periodoVista(anterior)).montoAbonado)).toBe('0');
      expect(dec((await periodoVista(mes)).montoAbonado)).toBe('70000');
    });
  });

  describe('Periodos y resumen del carro', () => {
    it('configurar la cuota de un mes existente la actualiza (no duplica) y el resumen ordena del más reciente al más antiguo', async () => {
      const a = await cuota(anterior, '1810000');
      const b = await cuota(anterior, '1400000');
      expect(a.creado).toBe(true);
      expect(b.creado).toBe(false);
      await cuota(mes);
      expect(await s.prisma.obligacionesMes.count()).toBe(2);

      const resumen = await s.aportesCarro.resumenCarro(semilla.userId);
      expect(resumen.periodos.map((p) => p.periodo)).toEqual([mes, anterior]);
      expect(dec(resumen.periodos[1].valorCuotaObjetivo)).toBe('1400000');
      expect(Number(resumen.responsable?.id)).toBe(semilla.papaId);
      expect(resumen.periodoSeleccionadoId).toBe(resumen.periodos[0].id); // el mes actual
    });

    it('el alta clásica de un periodo repetido responde 409 con instrucciones', async () => {
      await cuota(anterior);
      await expect(
        s.obligaciones.create(
          { tipoObligacion: 'CUOTA_CARRO' as any, responsablePrincipalId: semilla.papaId, concepto: 'x', periodo: anterior, metaMensual: 1, fechaInicio: `${anterior}-01` },
          semilla.userId,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('el resumen clásico (/obligaciones-mes) sigue coincidiendo con el del carro', async () => {
      await cuota(anterior);
      await aporte({ fecha: `${mes}-02`, periodo: anterior, detalles: [{ valor: 250000, metodo: 'EFECTIVO', personaId: semilla.papaId }, { valor: 50000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId }] });
      const [clasico] = await s.obligaciones.listResumen(semilla.userId, anterior, 'CUOTA_CARRO');
      const nuevo = await periodoVista(anterior);
      expect(dec(clasico.aporte_total_real)).toBe(dec(nuevo.montoAbonado));
      expect(dec(clasico.aportado_por_cruces)).toBe(dec(nuevo.aportadoPorCruces));
      expect(clasico.estado_calculado).toBe(nuevo.estadoCalculado);
    });
  });

  describe('Cargos recurrentes por persona', () => {
    const crear = (extra: Record<string, unknown>) => s.recurrentesPersona.create({ concepto: 'Plan de celular', valorMensual: 65000, mesInicio: anterior, ...extra } as any, semilla.userId);

    it('INDEFINIDO (de por vida) se cobra todos los meses desde el inicio, de forma idempotente', async () => {
      await crear({ personaId: semilla.andresId });
      const r1 = await s.recurrentesPersona.generarMes(mes, semilla.userId);
      expect(r1.movimientosGenerados).toBe(2); // mes anterior + mes actual
      const movs = await movimientos(semilla.andresId);
      expect(movs.map((m) => [m.periodo_imputacion, m.tipo_movimiento, m.signo, dec(m.monto), m.estado])).toEqual([
        [anterior, 'CARGO_RECURRENTE_PERSONA', 1, '65000', 'CONFIRMADO'],
        [mes, 'CARGO_RECURRENTE_PERSONA', 1, '65000', 'CONFIRMADO'],
      ]);
      expect(movs[1].concepto).toBe('Plan de celular (Mensual Recurrente)');

      const r2 = await s.recurrentesPersona.generarMes(mes, semilla.userId);
      expect(r2.movimientosGenerados).toBe(0); // idempotente
      expect(await s.prisma.movimientosDeudaPersona.count()).toBe(2);

      // un mes futuro queda PROYECTADO y se genera una sola vez
      await s.recurrentesPersona.generarMes(siguiente, semilla.userId);
      await s.recurrentesPersona.generarMes(siguiente, semilla.userId);
      const futuro = (await movimientos(semilla.andresId)).filter((m) => m.periodo_imputacion === siguiente);
      expect(futuro).toHaveLength(1);
      expect(futuro[0].estado).toBe('PROYECTADO');
      const lista = await s.recurrentesPersona.list(semilla.userId);
      expect(lista[0]).toMatchObject({ vitalicio: true, progreso: null, estado: 'ACTIVO', cuotasGeneradas: 3 });
    });

    it('PLAZO_FIJO de X meses: cuota k de X, se cierra en la X y no genera más', async () => {
      await crear({ personaId: semilla.papaId, concepto: 'Seguro del carro', modalidadDuracion: 'PLAZO_FIJO', numeroMeses: 2, valorMensual: 80000 });
      await s.recurrentesPersona.generarMes(siguiente, semilla.userId); // pide un mes más allá del plazo

      const movs = await movimientos(semilla.papaId);
      expect(movs.map((m) => m.concepto)).toEqual(['Seguro del carro (Cuota 1 de 2)', 'Seguro del carro (Cuota 2 de 2)']);
      expect(movs.map((m) => m.periodo_imputacion)).toEqual([anterior, mes]);

      const [rec] = await s.recurrentesPersona.list(semilla.userId);
      expect(rec).toMatchObject({ estado: 'FINALIZADO', cuotasGeneradas: 2, mesFin: mes, progreso: { actual: 2, total: 2, porcentaje: 100 } });

      await s.recurrentesPersona.generarMes(siguiente, semilla.userId);
      expect(await s.prisma.movimientosDeudaPersona.count()).toBe(2);
    });

    it('un valor a favor (ABONO_A_FAVOR) resta del estado de cuenta; el día de cobro se ajusta al último día del mes', async () => {
      await crear({ personaId: semilla.andresId, concepto: 'Descuento', naturaleza: 'ABONO_A_FAVOR', valorMensual: 10000, diaCobro: 31, mesInicio: '2026-02' });
      await s.recurrentesPersona.generarMes('2026-02', semilla.userId);
      const [mov] = await movimientos(semilla.andresId);
      expect(mov).toMatchObject({ tipo_movimiento: 'ABONO_RECURRENTE_PERSONA', signo: -1, periodo_imputacion: '2026-02' });
      expect(mov.fecha_movimiento.toISOString().slice(0, 10)).toBe('2026-02-28');
    });

    it('pausar anula lo proyectado; reactivar lo vuelve a generar; eliminar anula todo el historial', async () => {
      const rec = await crear({ personaId: semilla.andresId, mesInicio: mes });
      await s.recurrentesPersona.generarMes(siguiente, semilla.userId);
      expect((await movimientos(semilla.andresId)).map((m) => m.estado)).toEqual(['CONFIRMADO', 'PROYECTADO']);

      await s.recurrentesPersona.update(Number(rec.id), { activo: false }, semilla.userId);
      expect((await movimientos(semilla.andresId)).map((m) => m.estado)).toEqual(['CONFIRMADO', 'ANULADO']);

      await s.recurrentesPersona.update(Number(rec.id), { activo: true, valorMensual: 70000 }, semilla.userId);
      await s.recurrentesPersona.generarMes(siguiente, semilla.userId);
      const movs = await movimientos(semilla.andresId);
      expect(movs.map((m) => [m.estado, dec(m.monto)])).toEqual([['CONFIRMADO', '65000'], ['PROYECTADO', '70000']]); // el historial confirmado no se reescribe

      const r = await s.recurrentesPersona.remove(Number(rec.id), semilla.userId);
      expect(r).toMatchObject({ eliminado: true, movimientosAnulados: 2 });
      expect((await movimientos(semilla.andresId)).map((m) => m.estado)).toEqual(['ANULADO', 'ANULADO']);
      expect(await s.prisma.cargosRecurrentesPersona.count()).toBe(0);
    });

    it('validaciones: plazo obligatorio, prohibido con indefinido, persona ajena, no acortar bajo lo generado', async () => {
      await expect(crear({ personaId: semilla.andresId, modalidadDuracion: 'PLAZO_FIJO' })).rejects.toMatchObject({ status: 400 });
      await expect(crear({ personaId: semilla.andresId, numeroMeses: 3 })).rejects.toMatchObject({ status: 400 });
      await expect(crear({ personaId: 99999 })).rejects.toMatchObject({ status: 404 });

      const rec = await crear({ personaId: semilla.andresId, modalidadDuracion: 'PLAZO_FIJO', numeroMeses: 6 });
      await s.recurrentesPersona.generarMes(mes, semilla.userId); // 2 cuotas
      await expect(s.recurrentesPersona.update(Number(rec.id), { numeroMeses: 1 }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.recurrentesPersona.update(Number(rec.id), { mesInicio: siguiente }, semilla.userId)).rejects.toMatchObject({ status: 409 });
      const ampliado = await s.recurrentesPersona.update(Number(rec.id), { numeroMeses: 12 }, semilla.userId);
      expect(ampliado).toMatchObject({ numeroMeses: 12, mesFin: mesRelativo(10), estado: 'ACTIVO' });
    });

    it('rechaza periodos fuera de rango al generar', async () => {
      await expect(s.recurrentesPersona.generarMes('2099-01', semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.recurrentesPersona.generarMes('1999-12', semilla.userId)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('Liquidación de fin de mes', () => {
    it('consolida tarjetas, préstamos, recurrentes, cruces y abonos de Andrés, y el faltante del carro de papá', async () => {
      // Andrés: cuota de tarjeta (50 % de 100.000), préstamo, recurrente, cruce desde un aporte del carro y un pago parcial
      const compra = await s.compras.save(
        { concepto: 'Nevera', valorCompra: 1200000, fechaCompra: `${mes}-05`, numeroCuotas: 12, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: semilla.tarjetaId },
        semilla.userId,
      );
      await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: compra }, semilla.userId);
      await s.prestamos.create({ valorPrestado: 80000, concepto: 'Domicilio', fechaCobro: `${mes}-20`, responsable: semilla.andresId, estado: 'Pendiente', comentarios: '' } as any, semilla.userId);
      await s.recurrentesPersona.create({ personaId: semilla.andresId, concepto: 'Plan de celular', valorMensual: 65000, mesInicio: mes } as any, semilla.userId);
      await cuota(mes, '1000000');
      await aporte({ fecha: `${mes}-14`, periodo: mes, detalles: [{ valor: 400000, metodo: 'EFECTIVO', personaId: semilla.papaId }, { valor: 100000, metodo: 'CRUCE_CUENTAS', personaId: semilla.andresId, comentarios: 'arreglo' }] });
      await s.liquidacion.registrarPago({ personaId: semilla.andresId, monto: 30000, cuentaDestinoId: semilla.nequiId } as any, semilla.userId);

      const r = await s.liquidacion.liquidacion(mes, semilla.userId);

      const andres = r.personas.find((p) => Number(p.persona.id) === semilla.andresId) as any;
      expect(andres.cuotasTarjetas.items.map((i: any) => dec(i.monto))).toEqual(['50000']);
      expect(andres.cuotasTarjetas.items[0].origen).toBe('COMPRA_CREDITO');
      expect(andres.cuotasPrestamos.items.map((i: any) => dec(i.monto))).toEqual(['80000']);
      expect(andres.cargosRecurrentes.items.map((i: any) => [i.concepto, dec(i.monto)])).toEqual([['Plan de celular (Mensual Recurrente)', '65000']]);
      expect(andres.crucesCuentas.items.map((i: any) => [i.origen, dec(i.monto), i.comentario])).toEqual([['CRUCE_APORTE_CARRO', '100000', 'arreglo']]);
      expect(andres.abonosRealizados.items.map((i: any) => dec(i.monto))).toEqual(['30000']);
      expect(dec(andres.resumenNeto.totalCargos)).toBe('295000'); // 50.000 + 80.000 + 65.000 + 100.000
      expect(dec(andres.resumenNeto.totalAbonosYFavor)).toBe('30000');
      expect(dec(andres.resumenNeto.saldoNetoFinal)).toBe('265000');
      expect(andres.resumenNeto.estado).toBe('DEBE');
      expect(andres.estadoAporteCarro).toBeNull(); // Andrés no es el responsable de la cuota

      // Papá: aportó 500.000 de 1.000.000 (400.000 efectivo + 100.000 por el cruce de Andrés) → faltan 500.000
      const papa = r.personas.find((p) => Number(p.persona.id) === semilla.papaId) as any;
      expect(papa.estadoAporteCarro).toMatchObject({ estado: 'PARCIAL' });
      expect(dec(papa.estadoAporteCarro.montoAbonado)).toBe('500000');
      expect(dec(papa.faltanteObligacion)).toBe('500000');
      expect(dec(papa.resumenNeto.saldoNetoFinal)).toBe('500000');

      expect(dec(r.totales.saldoNetoFinal)).toBe('765000');
      // el que más debe va primero
      expect(Number(r.personas[0].persona.id)).toBe(semilla.papaId);
      // el mismo resultado persona a persona
      const solo = await s.liquidacion.liquidacionPersona(mes, semilla.andresId, semilla.userId);
      expect(dec(solo.resumenNeto.saldoNetoFinal)).toBe('265000');
    });

    it('con saldo a favor del carro aplicado al estado de cuenta, papá queda a favor; sin movimientos, paz y salvo', async () => {
      await cuota(anterior);
      const p = await aporte({ fecha: `${mes}-03`, periodo: anterior, detalles: [{ valor: 1300000, metodo: 'EFECTIVO', personaId: semilla.papaId }] });
      await s.aportesCarro.aplicarExcedente(Number(p.periodo.id), { destino: 'ESTADO_CUENTA', periodoImputacion: mes } as any, semilla.userId);

      const papa = await s.liquidacion.liquidacionPersona(mes, semilla.papaId, semilla.userId);
      expect(dec(papa.saldoAFavorAplicado.subtotal)).toBe('-300000');
      expect(dec(papa.resumenNeto.saldoNetoFinal)).toBe('-300000');
      expect(papa.resumenNeto.estado).toBe('A_FAVOR');

      const sinNada = await s.liquidacion.liquidacionPersona(mes, semilla.andresId, semilla.userId);
      expect(sinNada.resumenNeto.estado).toBe('PAZ_Y_SALVO');
    });

    it('genera los recurrentes del mes al consultar y nunca se repite aunque se consulte varias veces', async () => {
      await s.recurrentesPersona.create({ personaId: semilla.andresId, concepto: 'Streaming', valorMensual: 25000, mesInicio: mes } as any, semilla.userId);
      await s.liquidacion.liquidacion(mes, semilla.userId);
      await s.liquidacion.liquidacion(mes, semilla.userId);
      const r = await s.liquidacion.liquidacion(mes, semilla.userId);
      expect(r.recurrentesGenerados).toBe(0);
      expect(await s.prisma.movimientosDeudaPersona.count()).toBe(1);
      expect(dec(r.totales.saldoNetoFinal)).toBe('25000');
    });

    it('cruce directo entre personas: abona a una y carga a la otra', async () => {
      const cruce = await s.liquidacion.cruceEntrePersonas(
        { personaOrigenId: semilla.papaId, personaDestinoId: semilla.andresId, monto: 100000, periodo: mes, concepto: 'Andrés paga lo de papá' } as any,
        semilla.userId,
      );
      expect(cruce.movimientos).toHaveLength(2);
      const papa = await s.liquidacion.liquidacionPersona(mes, semilla.papaId, semilla.userId);
      const andres = await s.liquidacion.liquidacionPersona(mes, semilla.andresId, semilla.userId);
      expect(dec(papa.resumenNeto.saldoNetoFinal)).toBe('-100000');
      expect(dec(andres.resumenNeto.saldoNetoFinal)).toBe('100000');
      expect(andres.crucesCuentas.items[0].origen).toBe('CRUCE_ENTRE_PERSONAS');
    });

    it('registrar pago sin cuenta solo anota el abono; con corte exige cuenta; persona ajena → 404', async () => {
      const r = await s.liquidacion.registrarPago({ personaId: semilla.andresId, monto: 5000, periodo: mes } as any, semilla.userId);
      expect(r.movimientoId).toBeGreaterThan(0);
      expect(await s.prisma.transacciones.count()).toBe(0);
      expect((await movimientos(semilla.andresId))[0]).toMatchObject({ tipo_movimiento: 'ABONO_PAGO_RECIBIDO', signo: -1, transaccion_id: null });
      await expect(s.liquidacion.registrarPago({ personaId: semilla.andresId, monto: 1, liquidarPrestamosCorteId: semilla.corteId } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.liquidacion.registrarPago({ personaId: 99999, monto: 1 } as any, semilla.userId)).rejects.toMatchObject({ status: 404 });
    });

    it('un asiento ANULADO no cuenta en la liquidación (p. ej. el recurrente pausado)', async () => {
      const rec = await s.recurrentesPersona.create({ personaId: semilla.andresId, concepto: 'Streaming', valorMensual: 25000, mesInicio: mes } as any, semilla.userId);
      const antes = await s.liquidacion.liquidacionPersona(siguiente, semilla.andresId, semilla.userId);
      expect(dec(antes.resumenNeto.saldoNetoFinal)).toBe('25000'); // proyectado del mes siguiente

      await s.recurrentesPersona.update(Number(rec.id), { activo: false }, semilla.userId);
      const despues = await s.liquidacion.liquidacionPersona(siguiente, semilla.andresId, semilla.userId);
      expect(dec(despues.resumenNeto.saldoNetoFinal)).toBe('0');
      expect(despues.cargosRecurrentes.items).toHaveLength(0);
    });
  });
});
