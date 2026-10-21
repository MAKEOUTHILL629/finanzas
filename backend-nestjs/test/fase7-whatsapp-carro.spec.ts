import { Decimal } from '../src/config/decimal.config';
import { AportesCarroService } from '../src/modules/obligaciones-aportes/aportes-carro.service';

const d = (v: string) => new Decimal(v);

describe('Fase 7 — Resumen WhatsApp de aportes del carro', () => {
  it('consolida el último aporte y el acumulado por persona del periodo elegido con teléfono del responsable', async () => {
    const prisma: any = {
      obligacionesMes: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 66n,
            owner_user_id: 7n,
            tipo_obligacion: 'CUOTA_CARRO',
            periodo: '2026-10',
            concepto: 'Octubre 2026',
            meta_mensual: d('1000000'),
            saldo_a_favor_aplicado: d('0'),
            responsable_principal_id: 4n,
            responsable_principal: { id: 4n, nombre: 'Luis Fernando', iniciales_nombre: 'LF', color_representativo: '#0071E3' },
            dias: [
              {
                id: 10n,
                obligacion_mes_id: 66n,
                fecha: new Date('2026-10-20T00:00:00.000Z'),
                notas: 'Entrega diaria',
                detalles: [
                  {
                    id: 1n,
                    aporte_dia_id: 10n,
                    valor: d('450000'),
                    metodo: 'EFECTIVO',
                    persona_id: 4n,
                    persona: { id: 4n, nombre: 'Luis Fernando', iniciales_nombre: 'LF', color_representativo: '#0071E3' },
                    comentarios: 'Aporte Papá',
                    cuenta_financiera_id: 9n,
                    cuenta: { id: 9n, nombre: 'Efectivo' },
                    transaccion_id: 55n,
                    prestamo_cruce_generado_id: null,
                    origen_obligacion_mes_id: null,
                  },
                  {
                    id: 2n,
                    aporte_dia_id: 10n,
                    valor: d('150000'),
                    metodo: 'CRUCE_CUENTAS',
                    persona_id: 2n,
                    persona: { id: 2n, nombre: 'Andrés', iniciales_nombre: 'AN', color_representativo: '#34C759' },
                    comentarios: 'Cruce taller',
                    cuenta_financiera_id: null,
                    cuenta: null,
                    transaccion_id: null,
                    prestamo_cruce_generado_id: 77n,
                    origen_obligacion_mes_id: null,
                  },
                ],
              },
            ],
          },
        ]),
      },
      personas: {
        findFirst: jest.fn().mockResolvedValue({ numero_celular: '3001112233' }),
      },
    };
    const svc = new AportesCarroService(prisma, {} as any);
    const res = await svc.resumenWhatsApp(7n, '2026-10');

    expect(res.periodo).toBe('2026-10');
    expect(res.nombrePeriodoMes).toBe('Octubre 2026');
    expect(res.responsable).toMatchObject({ id: 4n, nombre: 'Luis Fernando', telefono: '3001112233' });
    expect(res.ultimoAporte?.aportante).toBe('Luis Fernando');
    expect(res.ultimoAporte?.monto.toString()).toBe('450000');
    expect(res.resumenPeriodo?.metaMes.toString()).toBe('1000000');
    expect(res.resumenPeriodo?.totalRecaudadoMes.toString()).toBe('600000');
    expect(res.resumenPeriodo?.saldoFaltanteMes.toString()).toBe('400000');
    expect(res.resumenPeriodo?.desglosePorPersona.map((p) => [p.nombre, p.monto.toString()])).toEqual([
      ['Luis Fernando', '450000'],
      ['Andrés', '150000'],
    ]);
  });

  it('Fase 6: el resumen del periodo desglosa efectivo vs. transferencia por aportante', async () => {
    const prisma: any = {
      obligacionesMes: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 66n,
            owner_user_id: 7n,
            tipo_obligacion: 'CUOTA_CARRO',
            periodo: '2026-10',
            concepto: 'Octubre 2026',
            meta_mensual: d('1000000'),
            saldo_a_favor_aplicado: d('0'),
            responsable_principal_id: 4n,
            responsable_principal: { id: 4n, nombre: 'Luis Fernando', iniciales_nombre: 'LF', color_representativo: '#0071E3' },
            dias: [
              {
                id: 10n,
                obligacion_mes_id: 66n,
                fecha: new Date('2026-10-20T00:00:00.000Z'),
                notas: null,
                detalles: [
                  { id: 1n, aporte_dia_id: 10n, valor: d('200000'), metodo: 'EFECTIVO', medio_pago: 'EFECTIVO', persona_id: 4n, persona: { id: 4n, nombre: 'Luis Fernando', iniciales_nombre: 'LF', color_representativo: null }, comentarios: null, cuenta_financiera_id: 9n, cuenta_destino_id: 9n, cuenta: { id: 9n, nombre: 'Efectivo' }, transaccion_id: 55n, prestamo_cruce_generado_id: null, origen_obligacion_mes_id: null },
                  { id: 2n, aporte_dia_id: 10n, valor: d('300000'), metodo: 'TRANSFERENCIA', medio_pago: 'TRANSFERENCIA', persona_id: 4n, persona: { id: 4n, nombre: 'Luis Fernando', iniciales_nombre: 'LF', color_representativo: null }, comentarios: null, cuenta_financiera_id: 3n, cuenta_destino_id: 3n, cuenta: { id: 3n, nombre: 'Bancolombia' }, transaccion_id: 56n, prestamo_cruce_generado_id: null, origen_obligacion_mes_id: null },
                ],
              },
            ],
          },
        ]),
      },
      personas: { findFirst: jest.fn().mockResolvedValue({ numero_celular: null }) },
    };
    const svc = new AportesCarroService(prisma, {} as any);
    const resumen = await svc.resumenCarro(7n, { periodo: '2026-10' });
    const periodo = resumen.periodos[0] as any;
    expect(periodo.totalAportesEfectivo.toString()).toBe('200000');
    expect(periodo.totalAportesTransferencia.toString()).toBe('300000');
    expect(periodo.transferenciasConciliadas).toBe(1);
    expect(periodo.resumenPorPersona[0]).toMatchObject({ nombre: 'Luis Fernando' });
    expect(periodo.aportes[0].detalles[1].medioPago).toBe('TRANSFERENCIA');
  });

  it('Fase 6: transferencias sugeridas excluye las ya vinculadas y ordena por cercanía de monto', async () => {
    const prisma: any = {
      transacciones: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1n, tipo_transaccion: 'INGRESO', concepto: 'Transferencia recibida', monto_cop: d('900000'), fecha_transaccion: new Date('2026-09-06T12:00:00Z'), estado: 'CONFIRMADO', cuenta_destino_id: 3n, cuenta_destino: { id: 3n, nombre: 'Bancolombia' } },
          { id: 2n, tipo_transaccion: 'INGRESO', concepto: 'Transferencia recibida', monto_cop: d('350000'), fecha_transaccion: new Date('2026-09-07T12:00:00Z'), estado: 'CONFIRMADO', cuenta_destino_id: 3n, cuenta_destino: { id: 3n, nombre: 'Bancolombia' } },
          { id: 3n, tipo_transaccion: 'INGRESO', concepto: 'Ya vinculada', monto_cop: d('350000'), fecha_transaccion: new Date('2026-09-07T12:00:00Z'), estado: 'CONFIRMADO', cuenta_destino_id: 3n, cuenta_destino: { id: 3n, nombre: 'Bancolombia' } },
        ]),
      },
      aportesDetalle: { findMany: jest.fn().mockResolvedValue([{ transaccion_id: 3n }]) },
    };
    const svc = new AportesCarroService(prisma, {} as any);
    const sugeridas = await svc.transferenciasSugeridas(7n, { monto: '350000', fecha: '2026-09-07' });
    expect(sugeridas.map((s) => s.id)).toEqual([2, 1]);
    expect(sugeridas[0]).toMatchObject({ monto: expect.anything(), cuentaNombre: 'Bancolombia' });
    expect(sugeridas[0].diferenciaMonto?.toString()).toBe('0');
  });
});
