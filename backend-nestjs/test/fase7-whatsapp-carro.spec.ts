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
});
