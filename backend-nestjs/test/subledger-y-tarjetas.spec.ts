/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { Decimal } from '../src/config/decimal.config';
import { ObligacionesAportesService } from '../src/modules/obligaciones-aportes/obligaciones-aportes.service';
import { SubledgerDeudasService } from '../src/modules/subledger-deudas/subledger-deudas.service';
import { TarjetasService } from '../src/modules/tarjetas/tarjetas.service';
import { WebScrapingService } from '../src/modules/tarjetas/web-scraping.service';
import { createPrismaMock, dec, sqlDe } from './helpers/prisma-mock';

const OWNER = 7n;

describe('SubledgerDeudasService', () => {
  function setup() {
    const prisma = createPrismaMock();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    return { prisma, service: new SubledgerDeudasService(prisma) };
  }

  describe('crearCruce (Trigger 5 genera el par -1 / +1)', () => {
    const dto = { personaQueAbonaId: 1, personaQueAsumeDeudaId: 2, monto: 100000, concepto: 'Cruce casa', prestamoDestinoId: 9 };

    it('inserta SOLO en CrucesDeuda; no escribe asientos en MovimientosDeudaPersona', async () => {
      const { prisma, service } = setup();
      prisma.prestamos.findFirst.mockResolvedValue({ id: 9n });
      prisma.crucesDeuda.create.mockResolvedValue({ id: 31n });
      prisma.crucesDeuda.findUniqueOrThrow.mockResolvedValue({ id: 31n, movimientos: [{}, {}] });

      await service.crearCruce(dto, OWNER);

      const { data } = prisma.crucesDeuda.create.mock.calls[0][0];
      expect(data).toMatchObject({
        owner_user_id: OWNER,
        persona_que_abona_id: 1n,
        persona_que_asume_deuda_id: 2n,
        prestamo_destino_id: 9n,
        periodo_recurrente_destino_id: null,
        concepto: 'Cruce casa',
      });
      expect(data.monto.toString()).toBe('100000');
      expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();
      expect(prisma.movimientosDeudaPersona.createMany).not.toHaveBeenCalled();
    });

    it('personas iguales, monto ≤ 0 o fecha inválida → 400', async () => {
      const { prisma, service } = setup();
      await expect(service.crearCruce({ ...dto, personaQueAsumeDeudaId: 1 }, OWNER)).rejects.toMatchObject({ status: 400 });
      await expect(service.crearCruce({ ...dto, monto: 0 }, OWNER)).rejects.toMatchObject({ status: 400 });
      await expect(service.crearCruce({ ...dto, fechaCruce: '13/10/2026' }, OWNER)).rejects.toMatchObject({ status: 400 });
      expect(prisma.crucesDeuda.create).not.toHaveBeenCalled();
    });

    it('personas ajenas → 404', async () => {
      const { prisma, service } = setup();
      prisma.personas.findFirst.mockResolvedValue(null);
      await expect(service.crearCruce(dto, OWNER)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('abonarPersona → sp_registrar_abono_persona', () => {
    it('llama al SP con todos los parámetros tipados y NO inserta transacciones/asientos desde TypeScript', async () => {
      const { prisma, service } = setup();
      prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
      prisma.$queryRaw.mockResolvedValue([{ movimiento_id: 555n }]);

      const r = await service.abonarPersona(2, { cuentaDestinoId: 3, monto: 350000.5, periodoImputacion: '2026-10', concepto: 'Pago Nequi' }, OWNER);

      const sql = sqlDe(prisma.$queryRaw);
      expect(sql).toContain('sp_registrar_abono_persona(');
      expect(sql).toContain('AS movimiento_id');
      const [, ...params] = prisma.$queryRaw.mock.calls[0];
      expect(params[0]).toBe(OWNER);
      expect(params[1]).toBe(2n);
      expect(params[2]).toBe(3n);
      expect(params[3].toString()).toBe('350000.5');
      expect(params[4]).toBe('2026-10');
      expect(params[5]).toBe('Pago Nequi');
      expect(params[6]).toBeNull();
      expect(r).toEqual({ movimientoId: 555, personaId: 2, monto: 350000.5, periodoImputacion: '2026-10' });
      expect(prisma.transacciones.create).not.toHaveBeenCalled();
      expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();
    });

    it('con corte a liquidar lo valida y lo pasa al SP', async () => {
      const { prisma, service } = setup();
      prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
      prisma.cortesCobro.findFirst.mockResolvedValue({ id: 12n });
      prisma.$queryRaw.mockResolvedValue([{ movimiento_id: 1n }]);
      await service.abonarPersona(2, { cuentaDestinoId: 3, monto: 10, periodoImputacion: '2026-10', concepto: 'x', liquidarPrestamosCorteId: 12 }, OWNER);
      expect(prisma.$queryRaw.mock.calls[0][7]).toBe(12n);
    });

    it('corte ajeno / cuenta ajena / monto inválido → no llama al SP', async () => {
      const { prisma, service } = setup();
      prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
      prisma.cortesCobro.findFirst.mockResolvedValue(null);
      await expect(
        service.abonarPersona(2, { cuentaDestinoId: 3, monto: 10, periodoImputacion: '2026-10', concepto: 'x', liquidarPrestamosCorteId: 99 }, OWNER),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.abonarPersona(2, { cuentaDestinoId: 3, monto: -5, periodoImputacion: '2026-10', concepto: 'x' }, OWNER),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('consultas 7.1, 7.2 y 7.4', () => {
    it('7.1 estado de cuenta: filtra por owner y periodo; columnas del documento', async () => {
      const { prisma, service } = setup();
      await service.estadoCuenta('2026-10', OWNER);
      const sql = sqlDe(prisma.$queryRaw);
      for (const col of ['cuotas_tc_mes', 'recurrentes_compartidos_mes', 'prestamos_mes', 'cruces_asumidos_mes', 'abonos_recibidos_mes', 'saldo_neto_mes', 'saldo_total_acumulado']) {
        expect(sql).toContain(col);
      }
      expect(sql).toContain('WHERE p.owner_user_id =');
      expect(sql).toContain("m.estado = 'CONFIRMADO'");
      expect(sql).toContain('ORDER BY saldo_total_acumulado DESC');
      expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(OWNER);
    });

    it('7.2 extracto: verifica la persona y filtra por owner/persona/periodo', async () => {
      const { prisma, service } = setup();
      await service.extracto(2, '2026-10', OWNER);
      const sql = sqlDe(prisma.$queryRaw);
      expect(sql).toContain('(m.monto * m.signo) AS impacto_saldo');
      expect(sql).toContain('ORDER BY m.fecha_movimiento ASC, m.id ASC');
      expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([OWNER, 2n, '2026-10']);
    });

    it('7.4 flujo de caja: devuelve la única fila', async () => {
      const { prisma, service } = setup();
      prisma.$queryRaw.mockResolvedValue([{ total_ingresos: dec('5000000'), flujo_caja_libre_estimado: dec('1200000') }]);
      const fila = await service.flujoCaja('2026-10', OWNER);
      expect(fila.flujo_caja_libre_estimado.toString()).toBe('1200000');
      const sql = sqlDe(prisma.$queryRaw);
      for (const cte of ['ingresos_mes', 'gastos_diarios_mes', 'tarjetas_mes', 'recurrentes_mes', 'reembolsos_terceros_mes']) {
        expect(sql).toContain(cte);
      }
      expect(sql).toContain("estado <> 'OMITIDO'");
    });

    it.each(['2026-13', '202610', '', 'abc'])('periodo inválido "%s" → 400', async (periodo) => {
      const { prisma, service } = setup();
      await expect(service.estadoCuenta(periodo, OWNER)).rejects.toMatchObject({ status: 400 });
      await expect(service.flujoCaja(periodo, OWNER)).rejects.toMatchObject({ status: 400 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});

describe('TarjetasService (v2 y legacy)', () => {
  function setup() {
    const prisma = createPrismaMock();
    const config = { get: (k: string) => (k === 'SCRAPING_DELAY_MS' ? 0 : undefined) } as unknown as ConfigService;
    const scraping = new WebScrapingService();
    return { prisma, scraping, service: new TarjetasService(prisma, scraping, config) };
  }

  it('pagarExtracto → sp_pagar_extracto_tarjeta con (owner, tarjeta, cuenta, periodo, monto)', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 4n });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    prisma.$queryRaw.mockResolvedValue([{ transaccion_id: 901n }]);

    const r = await service.pagarExtracto(4, OWNER, { cuentaOrigenId: 3, periodo: '2026-10', montoPagado: 1250000.5 });

    const sql = sqlDe(prisma.$queryRaw);
    expect(sql).toContain('sp_pagar_extracto_tarjeta(');
    expect(sql).toContain('AS transaccion_id');
    const [, ...params] = prisma.$queryRaw.mock.calls[0];
    expect(params.slice(0, 3)).toEqual([OWNER, 4n, 3n]);
    expect(params[3]).toBe('2026-10');
    expect(params[4].toString()).toBe('1250000.5');
    expect(r).toMatchObject({ transaccionId: 901, tarjetaId: 4, periodo: '2026-10', montoPagado: 1250000.5 });
    expect(prisma.cuentasFinancieras.update).not.toHaveBeenCalled(); // saldo: Trigger 2
  });

  it('pagarExtracto con tarjeta o cuenta ajenas → 404 y sin llamar al SP', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(null);
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    await expect(service.pagarExtracto(4, OWNER, { cuentaOrigenId: 3, periodo: '2026-10', montoPagado: 10 })).rejects.toMatchObject({ status: 404 });
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 4n });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue(null);
    await expect(service.pagarExtracto(4, OWNER, { cuentaOrigenId: 3, periodo: '2026-10', montoPagado: 10 })).rejects.toMatchObject({ status: 404 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('resumenMensual: consulta 7.3 con owner y periodo', async () => {
    const { prisma, service } = setup();
    await service.resumenMensual('2026-10', OWNER);
    const sql = sqlDe(prisma.$queryRaw);
    expect(sql).toContain('total_responsabilidad_terceros');
    expect(sql).toContain('componente_en_usd');
    expect(sql).toContain('todas_trm_confirmadas');
    expect(sql).toContain('WHERE t.owner_user_id =');
    expect(sql).toContain('IS DISTINCT FROM'); // terceros aun sin Persona enlazada
    expect(sql).toContain('LEFT JOIN LATERAL'); // % de terceros agregado por cuota: sin fan-out del JOIN
    expect(sql).toContain('cantidad_cuotas'); // solo las N primeras cuotas de cada responsable
    await expect(service.resumenMensual('2026/10', OWNER)).rejects.toMatchObject({ status: 400 });
  });

  it('list (legacy) serializa fechas como yyyy-MM-ddTHH:mm:ss y tasas como number', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findMany.mockResolvedValue([
      {
        id: 1n,
        created_at: new Date('2024-01-15T10:30:00Z'),
        franquicia: 'Mastercard',
        descripcion: 'Oro',
        tasa_interes_compra: dec('1.8895'),
        tasa_interes_avance: null,
        cuota_manejo: dec('36990'),
        url_info: 'https://x',
        ultima_actualizacion_tasas: new Date('2026-03-01T23:39:06.000Z'),
        extract_tasas: true,
        dia_corte: 15,
        dia_limite_pago: 30,
        cupo_total: dec('8000000'),
        permite_dolares: true,
      },
    ]);
    const [t] = await service.list(OWNER);
    expect(t).toMatchObject({
      id: 1,
      fechaCreacion: '2024-01-15T00:00:00',
      tasaInteresCompra: 1.8895,
      tasaInteresAvance: null,
      cuotaManejo: 36990,
      ultimaActualizacionTasas: '2026-03-01T23:39:06',
      extractTasas: true,
    });
    expect(prisma.tarjetas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: OWNER });
  });

  it('balance: total_saldo_restante como number', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([{ tarjeta: 1n, franquicia: 'Visa', total: dec('2500000.50') }]);
    expect(await service.balance(4, 2024, OWNER)).toEqual([{ tarjeta: 1, franquicia: 'Visa', total_saldo_restante: 2500000.5 }]);
  });

  describe('actualizar tasas (scraping)', () => {
    const tarjeta = (extra: Record<string, unknown> = {}) => ({
      id: 4n,
      created_at: new Date(),
      franquicia: 'Mastercard',
      extract_tasas: true,
      url_info: 'https://banco.test/tasas',
      ultima_actualizacion_tasas: null,
      ...extra,
    });
    const exito = {
      tarjetaId: 4,
      franquicia: 'Mastercard',
      tasaInteresCompraMensual: new Decimal('1.8895'),
      tasaInteresCompraAnual: null,
      tasaInteresAvanceMensual: null,
      tasaInteresAvanceAnual: null,
      cuotaManejo: new Decimal('36990'),
      exitoso: true,
      mensaje: 'Scraping exitoso',
    };

    it('actualizarTodas: omite las recientes, procesa las vencidas y resume', async () => {
      const { prisma, scraping, service } = setup();
      prisma.tarjetas.findMany.mockResolvedValue([
        tarjeta({ id: 1n, ultima_actualizacion_tasas: new Date(Date.now() - 2 * 86_400_000) }),
        tarjeta({ id: 2n }),
        tarjeta({ id: 3n }),
      ]);
      jest
        .spyOn(scraping, 'extraerTasas')
        .mockResolvedValueOnce({ ...exito, tarjetaId: 2 })
        .mockResolvedValueOnce({ ...exito, tarjetaId: 3, exitoso: false, mensaje: 'Error HTTP 500' });

      const r: any = await service.actualizarTodas(OWNER);

      expect(r.mensaje).toBe('Proceso completado: 1 actualizadas, 1 omitidas, 1 con error');
      expect(r).toMatchObject({ total: 3, actualizadas: 1, omitidas: 1, errores: 1 });
      expect(r.resultados.map((x: any) => x.estado)).toEqual(['OMITIDA', 'ACTUALIZADA', 'ERROR']);
      expect(r.resultados[0].mensaje).toContain('Próxima actualización disponible en 5 día(s)');
      expect(r.resultados[1].tasas).toEqual({
        interesCompraMensual: 1.8895,
        interesCompraAnual: null,
        interesAvanceMensual: null,
        interesAvanceAnual: null,
        cuotaManejo: 36990,
      });
      // guarda tasas con Decimal (4 decimales) y timestamp; las tasas ausentes se escriben como NULL (como el legacy)
      const data = prisma.tarjetas.update.mock.calls[0][0].data;
      expect(data.tasa_interes_compra.toString()).toBe('1.8895');
      expect(data.tasa_interes_avance).toBeNull();
      expect(data.cuota_manejo.toString()).toBe('36990');
      expect(data.ultima_actualizacion_tasas).toBeInstanceOf(Date);
    });

    it('sin tarjetas configuradas → mensaje legacy', async () => {
      const { prisma, service } = setup();
      prisma.tarjetas.findMany.mockResolvedValue([]);
      expect(await service.actualizarTodas(OWNER)).toEqual({
        mensaje: 'No hay tarjetas configuradas para scraping (extract_tasas = true y url_info no nulo)',
        total: 0,
        resultados: [],
      });
    });

    it('actualizarUna: 404 / 400 / 422 con la clave `mensaje`', async () => {
      const { prisma, scraping, service } = setup();
      prisma.tarjetas.findFirst.mockResolvedValueOnce(null);
      await expect(service.actualizarUna(4, OWNER)).rejects.toMatchObject({ status: 404, response: { mensaje: 'No se encontró la tarjeta con id=4' } });

      prisma.tarjetas.findFirst.mockResolvedValueOnce(tarjeta({ extract_tasas: false }));
      await expect(service.actualizarUna(4, OWNER)).rejects.toMatchObject({ status: 400 });

      prisma.tarjetas.findFirst.mockResolvedValueOnce(tarjeta({ url_info: null }));
      await expect(service.actualizarUna(4, OWNER)).rejects.toMatchObject({ status: 400 });

      prisma.tarjetas.findFirst.mockResolvedValueOnce(tarjeta());
      jest.spyOn(scraping, 'extraerTasas').mockResolvedValueOnce({ ...exito, exitoso: false, mensaje: 'No se pudieron extraer tasas' });
      await expect(service.actualizarUna(4, OWNER)).rejects.toMatchObject({ status: 422 });
    });

    it('actualizarUna ignora la restricción semanal y devuelve las tasas', async () => {
      const { prisma, scraping, service } = setup();
      prisma.tarjetas.findFirst.mockResolvedValue(tarjeta({ ultima_actualizacion_tasas: new Date() }));
      jest.spyOn(scraping, 'extraerTasas').mockResolvedValueOnce(exito);
      const r: any = await service.actualizarUna(4, OWNER);
      expect(r).toMatchObject({ mensaje: 'Tasas actualizadas correctamente', tarjetaId: 4, franquicia: 'Mastercard' });
      expect(r.tasas.interesCompraMensual).toBe(1.8895);
    });
  });
});

describe('ObligacionesAportesService', () => {
  function setup() {
    const prisma = createPrismaMock();
    prisma.obligacionesMes.findFirst.mockResolvedValue({ id: 20n, owner_user_id: OWNER });
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    return { prisma, service: new ObligacionesAportesService(prisma) };
  }

  it('registrarAportesDia: busca/crea el día, inserta los ítems uno a uno y NO crea préstamos (Trigger 3)', async () => {
    const { prisma, service } = setup();
    prisma.aportesDia.findFirst.mockResolvedValue(null);
    prisma.aportesDia.create.mockResolvedValue({ id: 200n, notas: null });
    prisma.aportesDetalle.create.mockResolvedValue({});
    prisma.aportesDia.findUniqueOrThrow.mockResolvedValue({
      id: 200n,
      obligacion_mes_id: 20n,
      fecha: new Date('2026-09-14T00:00:00.000Z'),
      notas: 'Día normal',
      obligacion_mes: { concepto: 'Cuota carro', periodo: '2026-09' },
    });
    prisma.aportesDetalle.findMany.mockResolvedValue([{ id: 1n, valor: dec('50000') }, { id: 2n, valor: dec('30000') }]);

    await service.registrarAportesDia(
      20,
      {
        fecha: '2026-09-14',
        notas: 'Día normal',
        items: [
          { personaId: 1, valor: 50000, metodo: 'Fisico' as any },
          { personaId: 2, valor: 30000, metodo: 'Prestamo' as any, comentarios: 'Los debe pagar Andres' },
        ],
      },
      OWNER,
    );

    expect(prisma.aportesDia.create.mock.calls[0][0].data).toMatchObject({ obligacion_mes_id: 20n, notas: 'Día normal' });
    expect(prisma.aportesDia.create.mock.calls[0][0].data.fecha.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(prisma.aportesDetalle.create).toHaveBeenCalledTimes(2);
    expect(prisma.aportesDetalle.create.mock.calls[1][0].data).toMatchObject({
      aporte_dia_id: 200n,
      persona_id: 2n,
      metodo: 'Prestamo',
      comentarios: 'Los debe pagar Andres',
    });
    expect(prisma.aportesDetalle.create.mock.calls[0][0].data.valor.toString()).toBe('50000');
    expect(prisma.prestamos.create).not.toHaveBeenCalled(); // lo crea el trigger BEFORE INSERT
    expect(prisma.aprobacionesPrestamos.create).not.toHaveBeenCalled();
    expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();
  });

  it('reutiliza el AportesDia existente de (obligación, fecha)', async () => {
    const { prisma, service } = setup();
    prisma.aportesDia.findFirst.mockResolvedValue({ id: 200n, notas: null });
    prisma.aportesDia.findUniqueOrThrow.mockResolvedValue({
      id: 200n,
      obligacion_mes_id: 20n,
      fecha: new Date('2026-09-14T00:00:00.000Z'),
      notas: null,
      obligacion_mes: { concepto: 'Cuota carro', periodo: '2026-09' },
    });
    prisma.aportesDetalle.create.mockResolvedValue({});
    await service.registrarAportesDia(20, { fecha: '2026-09-14', items: [{ personaId: 1, valor: 10, metodo: 'Nequi' as any }] }, OWNER);
    expect(prisma.aportesDia.create).not.toHaveBeenCalled();
  });

  it('obligación ajena → 404; persona ajena → 404; valor inválido → 400', async () => {
    const { prisma, service } = setup();
    const body = { fecha: '2026-09-14', items: [{ personaId: 1, valor: 10, metodo: 'Nequi' as any }] };
    prisma.obligacionesMes.findFirst.mockResolvedValueOnce(null);
    await expect(service.registrarAportesDia(20, body, OWNER)).rejects.toMatchObject({ status: 404 });

    prisma.personas.findFirst.mockResolvedValueOnce(null);
    await expect(service.registrarAportesDia(20, body, OWNER)).rejects.toMatchObject({ status: 404 });

    await expect(
      service.registrarAportesDia(20, { ...body, items: [{ personaId: 1, valor: 0, metodo: 'Nequi' as any }] }, OWNER),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.registrarAportesDia(20, { ...body, fecha: 'hoy' }, OWNER)).rejects.toMatchObject({ status: 400 });
  });

  const filaObligacion = (extra: any = {}) => ({
    id: 20n,
    owner_user_id: OWNER,
    tipo_obligacion: 'CUOTA_CARRO',
    responsable_principal_id: 5n,
    concepto: 'Cuota carro',
    periodo: '2026-09',
    meta_mensual: dec('1810000'),
    fecha_inicio: new Date('2026-09-01T00:00:00.000Z'),
    fecha_final: null,
    estado: 'ABIERTO',
    responsable_principal: { nombre: 'Papá' },
    dias: [
      { id: 1n, detalles: [{ persona_id: 5n, valor: dec('100000') }, { persona_id: 6n, valor: dec('50000.5') }] },
      { id: 2n, detalles: [] },
    ],
    ...extra,
  });

  it('resumen se calcula desde las tablas base (no desde vistas) filtrando por owner', async () => {
    const { prisma, service } = setup();
    prisma.obligacionesMes.findMany.mockResolvedValue([filaObligacion()]);
    const r: any = await service.resumen(20, OWNER);

    expect(prisma.obligacionesMes.findMany.mock.calls[0][0].where).toEqual({ id: 20n, owner_user_id: OWNER });
    expect(r).toMatchObject({
      obligacion_mes_id: 20n,
      owner_user_id: OWNER,
      responsable_principal_nombre: 'Papá',
      estado_calculado: 'ABIERTO',
      dias_aportados: 2,
      cantidad_registros: 2,
    });
    expect(r.meta_mensual.toString()).toBe('1810000');
    expect(r.aporte_total_real.toString()).toBe('150000.5');
    expect(r.restante_real.toString()).toBe('1659999.5');
    expect(r.aportado_directo_responsable.toString()).toBe('100000');
    expect(r.aportado_por_cruces.toString()).toBe('50000.5');

    prisma.obligacionesMes.findMany.mockResolvedValue([]);
    await expect(service.resumen(21, OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it('estado_calculado = COMPLETADO al alcanzar la meta y restante_real nunca arrastra -0', async () => {
    const { prisma, service } = setup();
    prisma.obligacionesMes.findMany.mockResolvedValue([
      filaObligacion({ meta_mensual: dec('150000.5') }),
      filaObligacion({ id: 21n, dias: [], meta_mensual: dec('0') }),
    ]);
    const [completa, vacia]: any[] = await service.listResumen(OWNER, '2026-09', 'CUOTA_CARRO');

    expect(prisma.obligacionesMes.findMany.mock.calls[0][0].where).toEqual({
      owner_user_id: OWNER,
      periodo: '2026-09',
      tipo_obligacion: 'CUOTA_CARRO',
    });
    expect(completa.estado_calculado).toBe('COMPLETADO');
    expect(completa.restante_real.toString()).toBe('0');
    expect(vacia).toMatchObject({ estado_calculado: 'COMPLETADO', dias_aportados: 0, cantidad_registros: 0 });
    expect(vacia.aporte_total_real.toString()).toBe('0');
    expect(Object.is(vacia.restante_real.toNumber(), -0)).toBe(false);
  });

  it('aportesDia: total y cantidad por día + desglose de AportesDetalle, sin leer ninguna vista', async () => {
    const { prisma, service } = setup();
    prisma.obligacionesMes.findFirst.mockResolvedValue({ id: 20n, owner_user_id: OWNER, concepto: 'Cuota carro', periodo: '2026-09' });
    prisma.aportesDia.findMany.mockResolvedValue([
      {
        id: 200n,
        obligacion_mes_id: 20n,
        fecha: new Date('2026-09-15T00:00:00.000Z'),
        notas: null,
        detalles: [{ id: 1n, aporte_dia_id: 200n, valor: dec('10.10') }, { id: 2n, aporte_dia_id: 200n, valor: dec('20.20') }],
      },
      { id: 201n, obligacion_mes_id: 20n, fecha: new Date('2026-09-14T00:00:00.000Z'), notas: 'x', detalles: [{ id: 3n, aporte_dia_id: 201n, valor: dec('5') }] },
    ]);
    const r: any = await service.aportesDia(20, OWNER);

    expect(prisma.aportesDia.findMany.mock.calls[0][0].where).toEqual({ obligacion_mes_id: 20n });
    expect(r.map((d: any) => [d.aporte_dia_id, d.items_count, d.valor_total_dia.toString()])).toEqual([
      [200n, 2, '30.3'],
      [201n, 1, '5'],
    ]);
    expect(r[0]).toMatchObject({ mes_concepto: 'Cuota carro', periodo: '2026-09', obligacion_mes_id: 20n });
    expect(r[0].detalles.map((d: any) => d.id)).toEqual([1n, 2n]);
    expect(r[1].detalles.map((d: any) => d.id)).toEqual([3n]);
  });
});
