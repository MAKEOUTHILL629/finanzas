import { Decimal } from '../src/config/decimal.config';
import {
  clasificarIntencionCorreo,
  detectarPatronRechazo,
  generarHuellaSincronizacion,
  normalizarTextoCorreoMulticapa,
} from '../src/modules/notificaciones-correo/clasificador-correo.util';
import { AuditoriaCorreosService } from '../src/modules/notificaciones-correo/auditoria-correos.service';
import { decidirRuta } from '../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { interpretarCuerpo } from '../src/modules/notificaciones-correo/cuerpo-correo.util';
import { ItemNormalizado, planificar } from '../src/modules/notificaciones-correo/planificador-correos';
import { CompraSnap, NotificacionSnap, SnapshotCorreos } from '../src/modules/notificaciones-correo/snapshot-correos';

const d = (v: string | number) => new Decimal(v);

function snap(over: Partial<SnapshotCorreos> = {}): SnapshotCorreos {
  return {
    ownerUserId: 1n,
    cuentas: [{ id: 1n, ultimos_4_digitos: '3698', moneda: 'COP', es_principal: true }],
    tarjetas: [{ id: 10n, descripcion: null, franquicia: 'Mastercard', ultimos_4_digitos: '9491', tasa_interes_compra: d('2'), tasa_interes_avance: null }],
    personas: [{ id: 1n, nombre: 'Yo', numero_celular: null }],
    miPersonaId: 1n,
    compras: [],
    transacciones: [],
    notificaciones: [],
    offset: '-05:00',
    trmRespaldo: null,
    ultimaTrmUsd: null,
    ...over,
  };
}

const item = (extra: Partial<ItemNormalizado> = {}): ItemNormalizado => ({
  externalMessageId: '<f1>',
  fecha: '2026-10-13',
  hora: '14:02:11',
  tipo: 'Compra',
  metodo: 'Tarjeta Credito',
  comercio: 'EXITO',
  origenRaw: 'T.Cred *9491',
  valor: '50.000',
  moneda: 'COP',
  ...extra,
});

describe('Fase 1 — clasificador semántico y filtro multicapa de rechazadas', () => {
  it.each([
    'Tu compra en EXITO no fue exitosa por fondos insuficientes',
    'La transacción fue declinada por cupo insuficiente',
    'Intento de compra rechazado: transacción fallida',
    'Bancolombia te informa que tu transacci=C3=B3n rechazada en RAPPI por $45.000',
    '<div>Compra <b>declinada</b> por c&oacute;digo de seguridad inv&aacute;lido (CVV errado)</div>',
    'No pudimos procesar tu pago: supera el tope diario permitido',
    'Operación denegada por tarjeta bloqueada temporalmente',
  ])('rechazada multicapa: %s', (texto) => {
    expect(clasificarIntencionCorreo([texto]).tipoIntencion).toBe('TRANSACCION_RECHAZADA');
    expect(clasificarIntencionCorreo([texto]).esCompraValida).toBe(false);
    expect(detectarPatronRechazo([texto])).toBeTruthy();
    expect(interpretarCuerpo(texto).rechazada).toBe(true);
  });

  it('decodifica quoted-printable y entidades HTML antes de evaluar patrones', () => {
    const norm = normalizarTextoCorreoMulticapa('Transacci=C3=B3n no aprobada &mdash; c&oacute;digo de seguridad inv&aacute;lido');
    expect(norm).toContain('transaccion no aprobada');
    expect(norm).toContain('codigo de seguridad invalido');
  });

  it('pago de tarjeta nunca es compra', () => {
    const cuerpo = interpretarCuerpo('Recibimos el pago de tu tarjeta MasterCard por $850.000');
    expect(cuerpo.pagoTarjeta).toBe(true);
    expect(decidirRuta({ tipo: 'Compra', metodo: 'Tarjeta Credito', origenRaw: 'T.Cred *9491' }, cuerpo)).toBe('PAGO_TARJETA');
    const plan = planificar(item({ cuerpoExtraido: 'Recibimos el pago de tu tarjeta MasterCard por $850.000', comercio: 'Pago tarjeta' }), snap());
    expect(plan.analisis.tipoEvento).toBe('PAGO_TARJETA');
    expect(plan.analisis.esCompraValida).toBe(false);
    expect(plan.accion.tipo).not.toBe('CREAR_COMPRA');
  });

  it('correo rechazado (incluso rotulado Compra TC o con rechazo en asunto/comercio) queda DESCARTADO_RECHAZADO y no crea compra', () => {
    const planCuerpo = planificar(
      item({ tipo: 'Compra', metodo: 'Tarjeta Credito', cuerpoExtraido: 'Tu compra en EXITO no fue exitosa por fondos insuficientes' }),
      snap(),
    );
    expect(planCuerpo.estado).toBe('DESCARTADO_RECHAZADO');
    expect(planCuerpo.accion.tipo).toBe('NINGUNA');
    expect(planCuerpo.analisis.esCompraValida).toBe(false);

    const planAsunto = planificar(
      item({ tipo: 'Compra', metodo: 'Tarjeta Credito', asunto: 'Alerta: Transacción declinada en DLO*Didi', cuerpoExtraido: null }),
      snap(),
    );
    expect(planAsunto.estado).toBe('DESCARTADO_RECHAZADO');
    expect(planAsunto.accion.tipo).toBe('NINGUNA');
  });

  it('huella determinista: mismo minuto/monto/últimos4/comercio = misma huella', () => {
    const fecha = new Date('2026-10-13T19:02:11Z');
    const a = generarHuellaSincronizacion({ fecha, montoCentavos: '5000000', ultimos4: '9491', comercio: 'DL*DIDI FOOD CO' });
    const b = generarHuellaSincronizacion({ fecha: new Date('2026-10-13T19:02:45Z'), montoCentavos: '5000000', ultimos4: '9491', comercio: 'DIDI FOOD' });
    const c = generarHuellaSincronizacion({ fecha, montoCentavos: '5000100', ultimos4: '9491', comercio: 'DIDI FOOD' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe('Fase 1 — auditoría y purga histórica en cascada de rechazados', () => {
  it('detecta correos rechazados con compras/cuotas/transacciones asociadas y los purga en cascada', async () => {
    const notifRechazada = {
      id: 101n,
      owner_user_id: 1n,
      asunto: 'Alerta Bancolombia: Compra rechazada',
      cuerpo_extraido: 'Tu compra en RAPPI por $42.000 no fue exitosa por fondos insuficientes.',
      fecha_correo: new Date('2026-10-12T15:00:00Z'),
      monto_original: d(42000),
      estado_procesamiento: 'CONCILIADO',
      compra_credito_generada_id: 501n,
      transaccion_generada_id: 601n,
      datos_parseados: { comercio: 'RAPPI', tipo: 'Compra' },
    };

    const prismaMock: Record<string, any> = {
      notificacionesCorreo: {
        findMany: jest.fn().mockResolvedValue([notifRechazada]),
        findFirst: jest.fn().mockResolvedValue(notifRechazada),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cuentasFinancieras: {
        findMany: jest.fn().mockResolvedValue([{ id: 1n, nombre: 'Ahorros Bancolombia' }]),
      },
      cuotasDetalle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1001n, compra: 501n },
          { id: 1002n, compra: 501n },
        ]),
      },
      responsablesComprasCredito: {
        findMany: jest.fn().mockResolvedValue([{ id: 2001n, compra_credito: 501n }]),
      },
      transacciones: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 601n,
            estado: 'CONFIRMADO',
            tipo_transaccion: 'EGRESO',
            cuenta_origen_id: 1n,
            cuenta_destino_id: null,
            monto_cop: d(42000),
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({ id: 601n }),
        delete: jest.fn().mockResolvedValue({}),
      },
      movimientosDeudaPersona: {
        findMany: jest.fn().mockResolvedValue([{ id: 3001n, cuota_detalle_id: 1001n, responsable_compra_id: 2001n, transaccion_id: null }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      comprasCredito: {
        findFirst: jest.fn().mockResolvedValue({ id: 501n }),
      },
      periodosRecurrentes: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prismaMock)),
    };

    const comprasMock = {
      deleteTx: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AuditoriaCorreosService(prismaMock as never, comprasMock as never, {} as never);

    // 1. Dry-run
    const preview = await service.auditarYLimpiarRechazadosHistoricos(1n, false);
    expect(preview.ejecutado).toBe(false);
    expect(preview.correosRechazadosDetectados).toBe(1);
    expect(preview.comprasCreditoEliminadas).toBe(1);
    expect(preview.cuotasEliminadas).toBe(2);
    expect(preview.responsablesEliminados).toBe(1);
    expect(preview.movimientosDeudaEliminados).toBe(1);
    expect(preview.transaccionesEliminadas).toBe(1);
    expect(preview.saldosCuentasRestaurados).toEqual([
      { cuentaId: 1, nombreCuenta: 'Ahorros Bancolombia', diferenciaRestaurada: '42000.00' },
    ]);
    expect(comprasMock.deleteTx).not.toHaveBeenCalled();

    // 2. Ejecución de purga en cascada
    const purga = await service.auditarYLimpiarRechazadosHistoricos(1n, true);
    expect(purga.ejecutado).toBe(true);
    expect(purga.correosActualizadosADescartado).toBe(1);
    expect(purga.comprasCreditoEliminadas).toBe(1);
    expect(purga.transaccionesEliminadas).toBe(1);
    expect(comprasMock.deleteTx).toHaveBeenCalledWith(prismaMock, 501, 1n, { desdeDeshacer: true });
    expect(prismaMock.transacciones.delete).toHaveBeenCalledWith({ where: { id: 601n } });
  });
});

describe('Fase 1 — resolución en cascada', () => {
  it('sin últimos 4: resuelve la tarjeta por cadena de plásticos cuando el dígito es de un plástico renovado', () => {
    const plan = planificar(item({ origenRaw: 'T.Cred *9491' }), snap());
    expect(plan.analisis.tarjetaId).toBe(10n);
    expect(plan.analisis.confianzaResolucion).toBe('CADENA_PLASTICO');
    expect(plan.accion.tipo).toBe('CREAR_COMPRA');
  });

  it('sin últimos 4: infiere la tarjeta por historial del comercio (>80 %)', () => {
    const compras: CompraSnap[] = [1, 2, 3].map((i) => ({
      id: BigInt(i), tarjetaId: 10n, fecha: '2026-09-01', valorCop: d(1000), moneda: 'COP', valorOriginal: d(1000),
      concepto: 'EXITO', cuotas: 1, interes: d(0), vinculada: true, responsables: [],
    }));
    const notificaciones: NotificacionSnap[] = compras.map((c, i) => ({
      id: BigInt(i + 1), ultimos4: null, monto: d(1000), moneda: 'COP', fecha: new Date(), comercioNorm: 'exito',
      ruta: 'COMPRA_TC', estado: 'CONCILIADO', compraId: c.id, transaccionId: null, vinculo: 'CREADA', tarjetaId: 10n,
    }));
    const plan = planificar(item({ origenRaw: 'T.Cred' }), snap({ compras, notificaciones }));
    expect(plan.analisis.tarjetaId).toBe(10n);
    expect(plan.analisis.confianzaResolucion).toBe('ALTA_INFERIDA');
  });

  it('ventana ±36 h: enlaza la compra huérfana única con monto exacto y comercio similar', () => {
    const compra: CompraSnap = {
      id: 77n, tarjetaId: 10n, fecha: '2026-10-15', valorCop: d(50000), moneda: 'COP', valorOriginal: d(50000),
      concepto: 'EXITO', cuotas: 1, interes: d(0), vinculada: false, responsables: [],
    };
    // La compra es de 2 días calendario después (fuera del ±1 día del enlace clásico) pero dentro de ±36 h.
    const plan = planificar(item({ origenRaw: 'T.Cred *0000', hora: '23:30:00' }), snap({ compras: [compra] }));
    expect(plan.accion).toMatchObject({ tipo: 'VINCULAR_COMPRA', compraId: 77n });
    expect(plan.analisis.confianzaResolucion).toBe('VENTANA_36H');
  });
});
