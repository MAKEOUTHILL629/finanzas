import { Prisma } from '@prisma/client';
import { EstadoTransaccion, TipoTransaccion } from '../src/common/enums/finance.enums';
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';
import { planificar } from '../src/modules/notificaciones-correo/planificador-correos';
import { SnapshotCorreos } from '../src/modules/notificaciones-correo/snapshot-correos';

describe('Iteración 2 — Fase 4: Transferencias entre Cuentas Propias', () => {
  it('crearTransferenciaEntreCuentasPropias crea salida EGRESO, entrada INGRESO espejo enlazada y gasto 4x1000 opcional', async () => {
    const creadas: Array<Record<string, unknown>> = [];
    let nextId = 100n;

    const txMock = {
      cuentasFinancieras: {
        findFirst: jest.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id, owner_user_id: 1n })),
        findUnique: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve({ nombre: where.id === 1n ? 'Bancolombia Principal' : 'Nequi Secundaria' }),
        ),
      },
      transacciones: {
        create: jest.fn().mockImplementation(({ data }) => {
          const row = { id: ++nextId, ...data };
          creadas.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = creadas.findIndex((r) => r.id === where.id);
          if (idx >= 0) creadas[idx] = { ...creadas[idx], ...data };
          return Promise.resolve(creadas[idx]);
        }),
      },
    };

    const prismaMock = {
      $transaction: jest.fn().mockImplementation((cb) => cb(txMock)),
    } as any;

    const service = new TransaccionesService(prismaMock);
    const res = await service.crearTransferenciaEntreCuentasPropias(
      {
        cuentaOrigenId: 1,
        cuentaDestinoId: 2,
        monto: '250000.00',
        comisionGMF: '1000.00',
      },
      1n,
    );

    expect(res.salida.tipo_transaccion).toBe(TipoTransaccion.EGRESO);
    expect(res.salida.es_transferencia_interna).toBe(true);
    expect(res.salida.cuenta_contraparte_id).toBe(2n);
    expect(res.salida.transaccion_espejo_id).toBe(res.entrada.id);

    expect(res.entrada.tipo_transaccion).toBe(TipoTransaccion.INGRESO);
    expect(res.entrada.es_transferencia_interna).toBe(true);
    expect(res.entrada.cuenta_contraparte_id).toBe(1n);
    expect(res.entrada.transaccion_espejo_id).toBe(res.salida.id);

    expect(res.comision).not.toBeNull();
    expect(res.comision?.es_transferencia_interna).toBe(false);
    expect(res.comision?.tipo_transaccion).toBe(TipoTransaccion.EGRESO);
  });

  it('anular una transacción con transaccion_espejo_id anula ambos lados atómicamente', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({ id: 101n, estado: EstadoTransaccion.ANULADO });
    const prismaMock = {
      transacciones: {
        findFirst: jest.fn().mockResolvedValue({
          id: 101n,
          owner_user_id: 1n,
          transaccion_espejo_id: 102n,
          estado: EstadoTransaccion.CONFIRMADO,
        }),
      },
      $transaction: jest.fn().mockImplementation((cb) =>
        cb({
          transacciones: { update, updateMany },
        }),
      ),
    } as any;

    const service = new TransaccionesService(prismaMock);
    await service.anular(101, 1n);
    expect(update).toHaveBeenCalledWith({
      where: { id: 101n },
      data: { estado: EstadoTransaccion.ANULADO },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 102n, owner_user_id: 1n },
      data: { estado: EstadoTransaccion.ANULADO },
    });
  });

  it('planificar detecta transferencia entre cuentas propias cuando el destino coincide con otra cuenta del usuario', () => {
    const snap: SnapshotCorreos = {
      ownerUserId: 1n,
      cuentas: [
        { id: 1n, ultimos_4_digitos: '4248', moneda: 'COP', es_principal: true },
        { id: 2n, ultimos_4_digitos: '3698', moneda: 'COP', es_principal: false },
      ],
      tarjetas: [],
      personas: [],
      miPersonaId: null,
      compras: [],
      transacciones: [],
      notificaciones: [],
      offset: '-05:00',
      trmRespaldo: null,
      ultimaTrmUsd: null,
    };

    const plan = planificar(
      {
        externalMessageId: 'msg-own-transfer',
        fecha: '2026-10-18',
        hora: '14:20',
        tipo: 'Transferencia',
        metodo: 'App Bancolombia',
        comercio: 'Cuenta *3698',
        origenRaw: '*4248',
        valor: '180000',
        moneda: 'COP',
        asunto: 'Transferencia exitosa',
        cuerpoExtraido: 'Transferiste $180.000,00 desde tu cuenta *4248 a la cuenta *3698.',
      },
      snap,
    );

    expect(plan.accion.tipo).toBe('CREAR_TRANSACCION');
    if (plan.accion.tipo === 'CREAR_TRANSACCION') {
      expect(plan.accion.datos.esTransferenciaInterna).toBe(true);
      expect(plan.accion.datos.cuentaContraparteId).toBe(2);
    }
  });
});
