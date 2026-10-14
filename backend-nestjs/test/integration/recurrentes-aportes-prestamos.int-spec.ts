/* eslint-disable @typescript-eslint/no-explicit-any */
import { crearServicios, describeDb, finDeMes, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Gastos recurrentes (Trigger 7), aportes del carro/casa (Trigger 3), préstamos (Trigger 4) y cruces (Trigger 5)
 * en PostgreSQL real. NestJS solo dispara los triggers: nunca inserta los asientos del sub-ledger.
 */
describeDb('Integración BD — recurrentes, aportes, préstamos y cruces (Triggers 3, 4, 5, 7)', () => {
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

  const movimientos = (personaId: number) =>
    s.prisma.movimientosDeudaPersona.findMany({ where: { persona_id: BigInt(personaId) }, orderBy: { id: 'asc' } });

  describe('Gastos recurrentes', () => {
    async function plantillaVariable() {
      return s.recurrentes.createPlantilla(
        {
          nombre: 'Energía Enel',
          montoBaseEstimado: 150000,
          esMontoVariable: true,
          diaVencimientoEstimado: 20,
          cuentaDebitoDefaultId: semilla.bancolombiaId,
          responsables: [
            { personaId: semilla.andresId, porcentajeParticipacion: 25 },
            { personaId: semilla.yoId, porcentajeParticipacion: 75 },
          ],
        },
        semilla.userId,
      );
    }

    it('proyectar: variable = promedio móvil de los 3 últimos pagos reales; fijo = monto base; idempotente', async () => {
      const variable = await plantillaVariable();
      const fija = await s.recurrentes.createPlantilla({ nombre: 'Internet', montoBaseEstimado: 95000, diaVencimientoEstimado: 31 }, semilla.userId);
      const inactiva = await s.recurrentes.createPlantilla({ nombre: 'Vieja', montoBaseEstimado: 1, isActive: false }, semilla.userId);

      // historial: 4 meses con pago real; el promedio móvil toma solo los 3 más recientes
      const reales: Array<[number, string]> = [[-4, '999999'], [-3, '100000'], [-2, '200000'], [-1, '300000']];
      for (const [offset, monto] of reales) {
        await s.prisma.periodosRecurrentes.create({
          data: {
            plantilla_recurrente_id: variable.id,
            owner_user_id: semilla.userId,
            periodo: mesRelativo(offset),
            fecha_estimada_pago: new Date(`${mesRelativo(offset)}-20T00:00:00Z`),
            monto_pronosticado: monto,
            monto_real_pagado: monto,
            estado: 'PAGADO',
          },
        });
      }

      const r = await s.recurrentes.proyectar(mes, semilla.userId);
      expect(r.generados).toBe(2); // variable + fija (la inactiva no)

      const proyectados = await s.prisma.periodosRecurrentes.findMany({ where: { periodo: mes }, orderBy: { plantilla_recurrente_id: 'asc' } });
      expect(proyectados.map((p) => p.plantilla_recurrente_id)).toEqual([variable.id, fija.id]);
      expect(proyectados[0].monto_pronosticado.toString()).toBe('200000'); // (100000 + 200000 + 300000) / 3
      expect(proyectados[1].monto_pronosticado.toString()).toBe('95000');
      expect(proyectados[0].estado).toBe('PROYECTADO');
      expect(proyectados[0].fecha_estimada_pago.toISOString().slice(0, 10)).toBe(`${mes}-20`);
      expect(proyectados[1].fecha_estimada_pago.toISOString().slice(0, 10)).toBe(`${mes}-28`); // LEAST(31, 28)
      expect(inactiva.is_active).toBe(false);

      expect((await s.recurrentes.proyectar(mes, semilla.userId)).generados).toBe(0); // ON CONFLICT DO NOTHING
    });

    it('registrarPago: PAGADO dispara el Trigger 7 (cargo SOLO a terceros) y crea el EGRESO enlazado', async () => {
      const variable = await plantillaVariable();
      await s.recurrentes.proyectar(mes, semilla.userId);
      const periodo = await s.prisma.periodosRecurrentes.findFirstOrThrow({ where: { plantilla_recurrente_id: variable.id } });

      const r = await s.recurrentes.registrarPago(Number(periodo.id), { montoRealPagado: 240000, crearTransaccion: true }, semilla.userId);

      expect(r.estado).toBe('PAGADO');
      expect(r.monto_real_pagado?.toString()).toBe('240000');
      expect(r.transaccion_pago_id).not.toBeNull();
      const movs = await movimientos(semilla.andresId);
      expect(movs).toHaveLength(1);
      expect(movs[0]).toMatchObject({ tipo_movimiento: 'CARGO_GASTO_COMPARTIDO', signo: 1, estado: 'CONFIRMADO', periodo_imputacion: mes });
      expect(movs[0].monto.toString()).toBe('60000'); // 25 % de 240000
      expect(await movimientos(semilla.yoId)).toHaveLength(0); // tu propia cuota no es deuda
      expect((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(semilla.bancolombiaId) } })).saldo_actual.toString()).toBe('760000');

      // corregir el monto real actualiza el MISMO asiento (ON CONFLICT DO UPDATE) en lugar de duplicarlo
      await s.recurrentes.registrarPago(Number(periodo.id), { montoRealPagado: 250000 }, semilla.userId);
      const despues = await movimientos(semilla.andresId);
      expect(despues).toHaveLength(1);
      expect(despues[0].monto.toString()).toBe('62500');
    });

    it('monto fijo de participación y reparto por porcentaje conviven', async () => {
      const p = await s.recurrentes.createPlantilla(
        {
          nombre: 'Mercado',
          montoBaseEstimado: 800000,
          responsables: [{ personaId: semilla.andresId, montoFijoParticipacion: 120000 }, { personaId: semilla.papaId, porcentajeParticipacion: 10 }],
        },
        semilla.userId,
      );
      await s.recurrentes.proyectar(mes, semilla.userId);
      const periodo = await s.prisma.periodosRecurrentes.findFirstOrThrow({ where: { plantilla_recurrente_id: p.id } });
      await s.recurrentes.registrarPago(Number(periodo.id), { montoRealPagado: 900000, estado: 'FACTURADO' as any }, semilla.userId);
      expect((await movimientos(semilla.andresId))[0].monto.toString()).toBe('120000');
      expect((await movimientos(semilla.papaId))[0].monto.toString()).toBe('90000');
    });
  });

  describe('Aportes diarios del carro/casa (Trigger 3 + Trigger 4)', () => {
    async function obligacion() {
      return s.obligaciones.create(
        {
          tipoObligacion: 'CUOTA_CARRO' as any,
          responsablePrincipalId: semilla.papaId,
          concepto: `Cuota ${mes}`,
          periodo: mes,
          metaMensual: 1810000,
          fechaInicio: `${mes}-01`,
          fechaFinal: finDeMes(mes),
        },
        semilla.userId,
      );
    }

    it('el aporte de un TERCERO crea el préstamo por cruce, las 2 aprobaciones y el cargo (sin que NestJS lo haga)', async () => {
      const ob = await obligacion();
      const dia = await s.obligaciones.registrarAportesDia(
        Number(ob.id),
        {
          fecha: `${mes}-14`,
          notas: 'Día 14',
          items: [
            { personaId: semilla.papaId, valor: 100000, metodo: 'Fisico' as any },
            { personaId: semilla.andresId, valor: 50000, metodo: 'Prestamo' as any, comentarios: 'Los debe pagar Andres' },
            { personaId: semilla.yoId, valor: 20000, metodo: 'Nequi' as any },
          ],
        },
        semilla.userId,
      );

      const prestamos = await s.prisma.prestamos.findMany();
      expect(prestamos).toHaveLength(1); // solo el de Andrés (ni el papá ni "yo")
      expect(prestamos[0]).toMatchObject({
        owner_user_id: semilla.userId,
        responsable: BigInt(semilla.andresId),
        direccion_prestamo: 'POR_COBRAR',
        estado: 'Pendiente',
        metodo: 'Pago Fernando',
        corte_id: BigInt(semilla.corteId),
        creado_por_persona_id: BigInt(semilla.yoId),
      });
      expect(prestamos[0].valor_prestado?.toString()).toBe('50000');
      expect(prestamos[0].saldo_pendiente?.toString()).toBe('50000');

      const aprobaciones = await s.prisma.aprobacionesPrestamos.findMany({ orderBy: { id: 'asc' } });
      expect(aprobaciones.map((a) => [Number(a.persona_id), a.estado])).toEqual([
        [semilla.andresId, 'Pendiente'],
        [semilla.yoId, 'Aprobado'],
      ]);

      const detalleAndres = await s.prisma.aportesDetalle.findFirstOrThrow({ where: { persona_id: BigInt(semilla.andresId) } });
      expect(detalleAndres.prestamo_cruce_generado_id).toBe(prestamos[0].id);

      // Trigger 4: el préstamo entró al sub-ledger como CARGO_CRUCE_DEUDA (método "Pago Fernando")
      const movs = await movimientos(semilla.andresId);
      expect(movs).toHaveLength(1);
      expect(movs[0]).toMatchObject({ tipo_movimiento: 'CARGO_CRUCE_DEUDA', signo: 1, estado: 'CONFIRMADO' });
      expect(movs[0].monto.toString()).toBe('50000');

      expect(dia.detalles).toHaveLength(3);
    });

    it('vistas: resumen del mes (directo vs. cruces), restante y estado calculado', async () => {
      const ob = await obligacion();
      await s.obligaciones.registrarAportesDia(
        Number(ob.id),
        { fecha: `${mes}-14`, items: [{ personaId: semilla.papaId, valor: 100000, metodo: 'Fisico' as any }, { personaId: semilla.andresId, valor: 50000, metodo: 'Prestamo' as any }] },
        semilla.userId,
      );

      const r1 = await s.obligaciones.resumen(Number(ob.id), semilla.userId);
      expect(r1).toMatchObject({ estado_calculado: 'ABIERTO', responsable_principal_nombre: 'Papá' });
      expect(r1.meta_mensual?.toString()).toBe('1810000');
      expect(r1.aporte_total_real?.toString()).toBe('150000');
      expect(r1.restante_real?.toString()).toBe('1660000');
      expect(r1.aportado_directo_responsable?.toString()).toBe('100000');
      expect(r1.aportado_por_cruces?.toString()).toBe('50000');
      expect(Number(r1.dias_aportados)).toBe(1);
      expect(Number(r1.cantidad_registros)).toBe(2);

      // un segundo registro el MISMO día reutiliza AportesDia; otro día lo completa
      await s.obligaciones.registrarAportesDia(Number(ob.id), { fecha: `${mes}-14`, items: [{ personaId: semilla.papaId, valor: 10000, metodo: 'Nequi' as any }] }, semilla.userId);
      expect(await s.prisma.aportesDia.count()).toBe(1);
      await s.obligaciones.registrarAportesDia(Number(ob.id), { fecha: `${mes}-15`, items: [{ personaId: semilla.papaId, valor: 1650000, metodo: 'Bancolombia' as any }] }, semilla.userId);
      const r2 = await s.obligaciones.resumen(Number(ob.id), semilla.userId);
      expect(r2.estado_calculado).toBe('COMPLETADO');
      expect(r2.restante_real?.toString()).toBe('0');

      const dias = await s.obligaciones.aportesDia(Number(ob.id), semilla.userId);
      expect(dias).toHaveLength(2);
      expect(dias[0].detalles.length + dias[1].detalles.length).toBe(4);
      expect((await s.obligaciones.listResumen(semilla.userId, mes, 'CUOTA_CARRO')).length).toBe(1);
    });
  });

  describe('Préstamos (Trigger 4) y cruces de deuda (Trigger 5)', () => {
    const dto = (extra: Record<string, unknown> = {}) => ({
      valorPrestado: 500000,
      concepto: 'Préstamo para viaje',
      fechaCobro: `${mes}-28`,
      responsable: semilla.andresId,
      estado: 'Pendiente',
      comentarios: '',
      ...extra,
    });

    it('crear préstamo → cargo CARGO_PRESTAMO_DIRECTO; marcar Pagado → UN abono por el saldo y saldo 0', async () => {
      const id = await s.prestamos.create(dto() as any, semilla.userId);

      let movs = await movimientos(semilla.andresId);
      expect(movs).toHaveLength(1);
      expect(movs[0]).toMatchObject({ tipo_movimiento: 'CARGO_PRESTAMO_DIRECTO', signo: 1, prestamo_id: BigInt(id) });
      expect(movs[0].monto.toString()).toBe('500000');
      const guardado = await s.prisma.prestamos.findUniqueOrThrow({ where: { id: BigInt(id) } });
      expect(guardado.corte_id).toBe(BigInt(semilla.corteId)); // corte activo
      expect(guardado.creado_por_persona_id).toBe(BigInt(semilla.yoId));

      await s.prestamos.update(id, { estado: 'Pagado' as any }, semilla.userId);

      movs = await movimientos(semilla.andresId);
      expect(movs).toHaveLength(2);
      expect(movs[1]).toMatchObject({ tipo_movimiento: 'ABONO_PAGO_RECIBIDO', signo: -1 });
      expect(movs[1].monto.toString()).toBe('500000'); // el saldo se pone en 0 DESPUÉS del abono
      expect((await s.prisma.prestamos.findUniqueOrThrow({ where: { id: BigInt(id) } })).saldo_pendiente?.toString()).toBe('0');
    });

    it('PATCH préstamo con aprobaciones: aprobar/rechazar', async () => {
      const ob = await s.obligaciones.create(
        { tipoObligacion: 'CUOTA_CARRO' as any, responsablePrincipalId: semilla.papaId, concepto: 'x', periodo: mes, metaMensual: 1000, fechaInicio: `${mes}-01` },
        semilla.userId,
      );
      await s.obligaciones.registrarAportesDia(Number(ob.id), { fecha: `${mes}-10`, items: [{ personaId: semilla.andresId, valor: 1000, metodo: 'Prestamo' as any }] }, semilla.userId);
      const prestamo = await s.prisma.prestamos.findFirstOrThrow();
      const aprobaciones = await s.prestamos.listAprobaciones(Number(prestamo.id), semilla.userId);
      const deAndres = aprobaciones.find((a) => a.personaId === semilla.andresId);

      const r = await s.prestamos.resolverAprobacion(Number(prestamo.id), Number(deAndres?.id), { estado: 'Aprobado' as any, comentarios: 'Conforme' }, {
        userId: semilla.userId, email: 'felipe@example.com', role: 'user', name: null,
      });
      expect(r).toMatchObject({ estado: 'Aprobado', comentarios: 'Conforme' });
      expect(typeof r.fechaAprobacion).toBe('string'); // ISO-8601
    });

    it('cruce de deuda: un solo INSERT en CrucesDeuda produce el par -1 / +1 (Trigger 5)', async () => {
      const prestamoId = await s.prestamos.create(dto({ responsable: semilla.andresId, valorPrestado: 300000 }) as any, semilla.userId);

      const cruce = await s.subledger.crearCruce(
        { personaQueAbonaId: semilla.papaId, personaQueAsumeDeudaId: semilla.andresId, monto: 100000, concepto: 'Cuota de la casa', prestamoDestinoId: prestamoId },
        semilla.userId,
      );

      expect(cruce.movimientos).toHaveLength(2);
      const abono = cruce.movimientos.find((m) => m.signo === -1);
      const cargo = cruce.movimientos.find((m) => m.signo === 1);
      expect(abono).toMatchObject({ persona_id: BigInt(semilla.papaId), tipo_movimiento: 'ABONO_CRUCE_DEUDA', cruce_deuda_id: cruce.id, prestamo_id: BigInt(prestamoId) });
      expect(cargo).toMatchObject({ persona_id: BigInt(semilla.andresId), tipo_movimiento: 'CARGO_CRUCE_DEUDA', cruce_deuda_id: cruce.id });
      expect(abono?.monto.toString()).toBe('100000');
      expect(cargo?.monto.toString()).toBe('100000');
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { cruce_deuda_id: cruce.id } })).toBe(2);
    });

    it('cortes de cobro: activo por fecha, no se elimina con préstamos', async () => {
      const activo = await s.cortes.activo(semilla.userId);
      expect(Number(activo.id)).toBe(semilla.corteId);
      await s.prestamos.create(dto() as any, semilla.userId);
      await expect(s.cortes.remove(semilla.corteId, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });
  });
});
