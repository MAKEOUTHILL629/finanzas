/* eslint-disable @typescript-eslint/no-explicit-any */
import { GastosRecurrentesService, validarReparto } from '../src/modules/gastos-recurrentes/gastos-recurrentes.service';
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';
import { createPrismaMock, dec, sqlDe } from './helpers/prisma-mock';

const OWNER = 7n;

describe('validarReparto', () => {
  it('cada fila necesita porcentaje o monto fijo', () => {
    expect(validarReparto([{ personaId: 1 }])).toEqual(['responsables[0]: indica porcentajeParticipacion o montoFijoParticipacion']);
    expect(validarReparto([{ personaId: 1, porcentajeParticipacion: 50 }, { montoFijoParticipacion: 100000 }])).toEqual([]);
  });

  it('Σ porcentajes ≤ 100 con aritmética Decimal exacta', () => {
    expect(validarReparto([{ porcentajeParticipacion: 33.33 }, { porcentajeParticipacion: 33.33 }, { porcentajeParticipacion: 33.34 }])).toEqual([]);
    expect(validarReparto([{ porcentajeParticipacion: 0.1 }, { porcentajeParticipacion: 0.2 }])).toEqual([]);
    expect(validarReparto([{ porcentajeParticipacion: 60 }, { porcentajeParticipacion: 40.01 }])).toEqual([
      'La suma de porcentajes (100.01) no puede superar 100',
    ]);
  });
});

describe('GastosRecurrentesService', () => {
  function setup() {
    const prisma = createPrismaMock();
    const service = new GastosRecurrentesService(prisma, new TransaccionesService(prisma));
    return { prisma, service };
  }

  describe('proyectar (sección 6.2.C)', () => {
    it('ejecuta el INSERT ... SELECT con promedio móvil de 3 meses e idempotencia por (plantilla, periodo)', async () => {
      const { prisma, service } = setup();
      prisma.$executeRaw.mockResolvedValue(4);
      prisma.periodosRecurrentes.findMany.mockResolvedValue([{ id: 1n }, { id: 2n }, { id: 3n }, { id: 4n }]);

      const r = await service.proyectar('2026-11', OWNER);

      const sql = sqlDe(prisma.$executeRaw);
      expect(sql).toContain('INSERT INTO "PeriodosRecurrentes"');
      expect(sql).toContain('AVG(pr_hist.monto_real_pagado)');
      expect(sql).toContain('ORDER BY periodo DESC');
      expect(sql).toContain('LIMIT 3');
      expect(sql).toContain('LEAST(COALESCE(pl.dia_vencimiento_estimado, 15), 28)');
      expect(sql).toContain('ON CONFLICT (plantilla_recurrente_id, periodo) DO NOTHING');
      expect(sql).toContain("'PROYECTADO'");
      const params = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(params).toContain('2026-11');
      expect(params).toContain(OWNER);
      expect(r).toMatchObject({ periodo: '2026-11', generados: 4, total: 4 });
    });

    it('rechaza periodos mal formados', async () => {
      const { prisma, service } = setup();
      await expect(service.proyectar('2026-13', OWNER)).rejects.toMatchObject({ status: 400 });
      await expect(service.proyectar('26-11', OWNER)).rejects.toMatchObject({ status: 400 });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('registrarPago', () => {
    const periodo = (extra: Record<string, unknown> = {}) => ({
      id: 30n,
      plantilla_recurrente_id: 5n,
      owner_user_id: OWNER,
      periodo: '2026-10',
      estado: 'PROYECTADO',
      transaccion_pago_id: null,
      compra_credito_pago_id: null,
      ...extra,
    });
    const plantilla = { id: 5n, nombre: 'Energía Enel', categoria_id: 2n, cuenta_debito_default_id: 3n };

    function preparar(prisma: any, p = periodo()) {
      prisma.periodosRecurrentes.findFirst.mockResolvedValue(p);
      prisma.plantillasRecurrentes.findUniqueOrThrow = jest.fn().mockResolvedValue(plantilla);
      prisma.periodosRecurrentes.update.mockResolvedValue({});
      prisma.periodosRecurrentes.findUniqueOrThrow.mockResolvedValue({ id: 30n, estado: 'PAGADO' });
    }

    it('un SOLO UPDATE fija monto_real_pagado y estado (el Trigger 7 usa el monto real)', async () => {
      const { prisma, service } = setup();
      preparar(prisma);

      await service.registrarPago(30, { montoRealPagado: 845300.5 }, OWNER);

      expect(prisma.periodosRecurrentes.update).toHaveBeenCalledTimes(1);
      const { where, data } = prisma.periodosRecurrentes.update.mock.calls[0][0];
      expect(where).toEqual({ id: 30n });
      expect(data.estado).toBe('PAGADO');
      expect(data.monto_real_pagado.toString()).toBe('845300.5');
      expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled(); // lo hace el Trigger 7
      expect(prisma.movimientosDeudaPersona.createMany).not.toHaveBeenCalled();
    });

    it('estado FACTURADO permitido; OMITIDO/PROYECTADO no', async () => {
      const { prisma, service } = setup();
      preparar(prisma);
      await service.registrarPago(30, { montoRealPagado: 10, estado: 'FACTURADO' as any }, OWNER);
      expect(prisma.periodosRecurrentes.update.mock.calls[0][0].data.estado).toBe('FACTURADO');
      await expect(service.registrarPago(30, { montoRealPagado: 10, estado: 'OMITIDO' as any }, OWNER)).rejects.toMatchObject({ status: 400 });
    });

    it('crearTransaccion registra el EGRESO desde la cuenta de débito de la plantilla y lo enlaza', async () => {
      const { prisma, service } = setup();
      preparar(prisma);
      prisma.cuentasFinancieras.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
      prisma.categorias.findFirst.mockResolvedValue({ id: 2n });
      prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 901n, ...data }));

      await service.registrarPago(30, { montoRealPagado: 845300.5, crearTransaccion: true }, OWNER);

      const tx = prisma.transacciones.create.mock.calls[0][0].data;
      expect(tx).toMatchObject({ tipo_transaccion: 'EGRESO', cuenta_origen_id: 3n, categoria_id: 2n, estado: 'CONFIRMADO' });
      expect(tx.monto_cop.toString()).toBe('845300.5');
      expect(prisma.periodosRecurrentes.update.mock.calls[0][0].data.transaccion_pago_id).toBe(901n);
    });

    it('crearTransaccion sin cuenta disponible → 400', async () => {
      const { prisma, service } = setup();
      prisma.periodosRecurrentes.findFirst.mockResolvedValue(periodo());
      prisma.plantillasRecurrentes.findUniqueOrThrow = jest.fn().mockResolvedValue({ ...plantilla, cuenta_debito_default_id: null });
      await expect(service.registrarPago(30, { montoRealPagado: 10, crearTransaccion: true }, OWNER)).rejects.toMatchObject({ status: 400 });
      expect(prisma.periodosRecurrentes.update).not.toHaveBeenCalled();
    });

    it('periodo OMITIDO → 409; monto inválido → 400', async () => {
      const { prisma, service } = setup();
      preparar(prisma, periodo({ estado: 'OMITIDO' }));
      await expect(service.registrarPago(30, { montoRealPagado: 10 }, OWNER)).rejects.toMatchObject({ status: 409 });
      await expect(service.registrarPago(30, { montoRealPagado: 0 }, OWNER)).rejects.toMatchObject({ status: 400 });
    });

    it('enlaza una compra con tarjeta del mismo usuario', async () => {
      const { prisma, service } = setup();
      preparar(prisma);
      prisma.comprasCredito.findFirst.mockResolvedValue({ id: 66n });
      await service.registrarPago(30, { montoRealPagado: 50000, compraCreditoPagoId: 66 }, OWNER);
      expect(prisma.comprasCredito.findFirst.mock.calls[0][0].where).toEqual({ id: 66n, owner_user_id: OWNER });
      expect(prisma.periodosRecurrentes.update.mock.calls[0][0].data.compra_credito_pago_id).toBe(66n);
    });
  });

  describe('plantillas', () => {
    it('crear con reparto > 100 % → 400 sin escribir nada', async () => {
      const { prisma, service } = setup();
      await expect(
        service.createPlantilla(
          { nombre: 'Mercado', montoBaseEstimado: 800000, responsables: [{ porcentajeParticipacion: 70 }, { porcentajeParticipacion: 40 }] },
          OWNER,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.plantillasRecurrentes.create).not.toHaveBeenCalled();
    });

    it('crear con reparto válido guarda plantilla y responsables (porcentaje a 4 decimales)', async () => {
      const { prisma, service } = setup();
      prisma.plantillasRecurrentes.create.mockResolvedValue({ id: 5n });
      prisma.plantillasRecurrentes.findFirst.mockResolvedValue({ id: 5n, responsables: [] });
      prisma.personas.findFirst.mockResolvedValue({ id: 2n });

      await service.createPlantilla(
        {
          nombre: 'Internet',
          montoBaseEstimado: 95000,
          esMontoVariable: false,
          responsables: [{ personaId: 2, porcentajeParticipacion: 33.3333 }, { montoFijoParticipacion: 30000 }],
        },
        OWNER,
      );

      expect(prisma.plantillasRecurrentes.create.mock.calls[0][0].data).toMatchObject({
        owner_user_id: OWNER,
        frecuencia: 'MENSUAL',
        moneda: 'COP',
        is_active: true,
      });
      const filas = prisma.responsablesRecurrentes.createMany.mock.calls[0][0].data;
      expect(filas[0].porcentaje_participacion.toString()).toBe('33.3333');
      expect(filas[1].monto_fijo_participacion.toString()).toBe('30000');
      expect(filas[1].persona_id).toBeNull(); // tu propia cuota parte
    });

    it('eliminar: con periodos generados solo desactiva; sin historial borra', async () => {
      const { prisma, service } = setup();
      prisma.plantillasRecurrentes.findFirst.mockResolvedValue({ id: 5n, responsables: [] });
      prisma.periodosRecurrentes.count.mockResolvedValue(3);
      expect(await service.removePlantilla(5, OWNER)).toEqual({ eliminada: false, desactivada: true });
      expect(prisma.plantillasRecurrentes.update).toHaveBeenCalledWith({ where: { id: 5n }, data: { is_active: false } });

      prisma.periodosRecurrentes.count.mockResolvedValue(0);
      expect(await service.removePlantilla(5, OWNER)).toEqual({ eliminada: true, desactivada: false });
    });
  });
});

void dec;
