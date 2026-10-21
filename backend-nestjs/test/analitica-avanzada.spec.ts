/* eslint-disable @typescript-eslint/no-explicit-any */
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { createPrismaMock, dec, utc } from './helpers/prisma-mock';

const OWNER = 7n;

describe('DashboardService.analiticaAvanzada (Iteración 2 — Fase 6)', () => {
  function setup() {
    const prisma = createPrismaMock();
    const lookup: any = {
      cuentas: jest.fn().mockResolvedValue([]),
      tarjetas: jest.fn().mockResolvedValue([
        {
          id: 4,
          nombre: 'MasterCard',
          etiqueta: 'MasterCard ··1927',
          tipo: 'CREDITO',
          esGenerica: false,
          cupoTotal: 10000000,
          diaCorte: 15,
          diaLimitePago: 5,
        },
      ]),
    };
    const subledger: any = {
      flujoCaja: jest.fn().mockResolvedValue({
        periodo: '2026-10',
        total_ingresos: dec('8000000'),
        total_egresos_directos: dec('1500000'),
        total_tarjetas: dec('2000000'),
        total_esperado_recurrentes: dec('1200000'),
        total_por_cobrar_terceros: dec('500000'),
        desembolso_bruto_mes: dec('4700000'),
        gasto_neto_real_tuyo: dec('4200000'),
        flujo_caja_libre_estimado: dec('3800000'),
        total_transferencias_internas: dec('600000'),
      }),
    };
    const estadoCuentaPersonas: any = {
      listar: jest.fn().mockResolvedValue({
        personas: [],
        totales: {
          pagoDelMes: dec('500000'),
          aPagarAhora: dec('500000'),
          porVencer: dec('0'),
          deudaTotal: dec('900000'),
          historicoSinCargar: dec('0'),
        },
      }),
    };
    const service = new DashboardService(prisma, lookup, subledger, estadoCuentaPersonas);
    return { prisma, service };
  }

  it('retorna serieTemporal, distribucionCategorias, proyeccionCuotasTarjetas, mapaCalorHabitos, balanceDeudasYPrestamos y cascadaMensual', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findMany
      .mockResolvedValueOnce([
        {
          id: 1n,
          tipo_transaccion: 'INGRESO',
          monto_cop: dec('5000000'),
          fecha_transaccion: utc('2026-10-05'),
          concepto: 'Salario Octubre',
          categoria_id: null,
          es_transferencia_interna: false,
        },
        {
          id: 2n,
          tipo_transaccion: 'EGRESO',
          monto_cop: dec('300000'),
          fecha_transaccion: utc('2026-10-10'),
          concepto: 'Mercado Éxito',
          categoria_id: 5n,
          es_transferencia_interna: false,
        },
        {
          id: 3n,
          tipo_transaccion: 'EGRESO',
          monto_cop: dec('600000'),
          fecha_transaccion: utc('2026-10-12'),
          concepto: 'Transferencia a Nequi',
          categoria_id: null,
          es_transferencia_interna: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 9n,
          tipo_transaccion: 'EGRESO',
          monto_cop: dec('200000'),
          fecha_transaccion: utc('2026-09-10'),
          concepto: 'Mercado Éxito',
          categoria_id: 5n,
          es_transferencia_interna: false,
        },
      ]);
    prisma.categorias.findMany.mockResolvedValue([{ id: 5n, nombre: 'Alimentación', color: '#34C759' }]);
    prisma.$queryRaw.mockResolvedValue([
      {
        tarjeta_id: 4n,
        periodo: '2026-10',
        total: dec('1200000'),
        terceros: dec('400000'),
        sin_pagar: dec('1200000'),
        pendiente: dec('1200000'),
        pendiente_terceros: dec('400000'),
        capital_pendiente: dec('1000000'),
      },
    ]);
    prisma.prestamos.findMany.mockResolvedValue([
      { id: 10n, direccion_prestamo: 'POR_COBRAR', valor_prestado: dec('400000'), saldo_pendiente: dec('400000') },
      { id: 11n, direccion_prestamo: 'POR_PAGAR', valor_prestado: dec('250000'), saldo_pendiente: dec('250000') },
    ]);

    const res = await service.analiticaAvanzada(
      OWNER,
      {
        fechaInicio: '2026-10-01',
        fechaFin: '2026-10-31',
        granularidad: 'MES',
        soloGastoPropio: 'false',
      },
      utc('2026-10-20'),
    );

    expect(res.filtrosAplicados.granularidad).toBe('MES');
    expect(res.serieTemporal.length).toBe(1);
    expect(res.serieTemporal[0].ingresos.toString()).toBe('5000000');
    expect(res.serieTemporal[0].transferenciasInternas.toString()).toBe('600000');
    // 300k egreso propio + 800k parte propia de tarjeta (1200k - 400k) = 1100k
    expect(res.serieTemporal[0].gastosPropios.toString()).toBe('1100000');

    expect(res.distribucionCategorias.length).toBe(1);
    expect(res.distribucionCategorias[0].categoria).toBe('Alimentación');
    expect(res.distribucionCategorias[0].variacionPct).toBe(50); // 300k vs 200k = +50%
    expect(res.distribucionCategorias[0].comercios[0].comercio).toBe('Mercado Éxito');

    expect(res.proyeccionCuotasTarjetas.length).toBe(12);
    expect(res.proyeccionCuotasTarjetas[0].partePropia.toString()).toBe('800000');
    expect(res.proyeccionCuotasTarjetas[0].parteTerceros.toString()).toBe('400000');

    expect(res.mapaCalorHabitos.length).toBe(1);
    expect(res.balanceDeudasYPrestamos.meDebenPrestamos.toString()).toBe('400000');
    expect(res.balanceDeudasYPrestamos.deboPrestamosPasivos.toString()).toBe('250000');
    expect(res.cascadaMensual.flujoLibreReal.toString()).toBe('3800000');
  });
});
