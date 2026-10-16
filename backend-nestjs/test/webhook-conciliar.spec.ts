/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from '@nestjs/common';
import { reescribirAliasV2 } from '../src/app.setup';
import { secretsMatch, WebhookOrJwtGuard } from '../src/common/guards/webhook-or-jwt.guard';
import { NotificacionesCorreoService } from '../src/modules/notificaciones-correo/notificaciones-correo.service';
import { PrestamosService } from '../src/modules/prestamos/prestamos.service';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 7n;

// ───────────────────────────── WebhookOrJwtGuard ─────────────────────────────

describe('WebhookOrJwtGuard', () => {
  const contexto = (headers: Record<string, unknown>) => {
    const request: any = { headers };
    return { request, ctx: { switchToHttp: () => ({ getRequest: () => request }) } as any };
  };
  const guard = (config: Record<string, unknown> = { WEBHOOK_SECRET: 'secreto-1234567890ab', DEFAULT_OWNER_USER_ID: '5' }) =>
    new WebhookOrJwtGuard({ get: (k: string) => config[k] } as any);

  it('secreto correcto → actúa como DEFAULT_OWNER_USER_ID (bigint) con rol webhook', async () => {
    const { request, ctx } = contexto({ 'x-webhook-secret': 'secreto-1234567890ab' });
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toMatchObject({ userId: 5n, role: 'webhook' });
  });

  it('secreto incorrecto → 401 { status: "error", message: "Invalid webhook secret" } (no cae a JWT)', async () => {
    const { ctx } = contexto({ 'x-webhook-secret': 'otro-secreto-xxxxxxxx' });
    const error: HttpException = await guard()
      .canActivate(ctx)
      .then(
        () => {
          throw new Error('debía rechazar');
        },
        (e) => e,
      );
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toEqual({ status: 'error', message: 'Invalid webhook secret' });
  });

  it('header vacío o servidor sin WEBHOOK_SECRET → 401 (nunca acepta "" == undefined)', async () => {
    await expect(guard().canActivate(contexto({ 'x-webhook-secret': '' }).ctx)).rejects.toMatchObject({ status: 401 });
    await expect(guard({ DEFAULT_OWNER_USER_ID: '5' }).canActivate(contexto({ 'x-webhook-secret': 'lo-que-sea' }).ctx)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('secreto válido pero DEFAULT_OWNER_USER_ID sin configurar → 503', async () => {
    const g = guard({ WEBHOOK_SECRET: 'secreto-1234567890ab' });
    await expect(g.canActivate(contexto({ 'x-webhook-secret': 'secreto-1234567890ab' }).ctx)).rejects.toMatchObject({ status: 503 });
  });

  it('secretsMatch compara en tiempo constante, también con longitudes distintas', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', 'abc')).toBe(false);
  });
});

// ───────────────────────────── alias /api/v2 ─────────────────────────────

describe('reescribirAliasV2', () => {
  it.each([
    ['/api/v2/transacciones?periodo=2026-10', '/api/transacciones?periodo=2026-10'],
    ['/api/v2/cuentas-financieras/3', '/api/cuentas-financieras/3'],
    ['/api/v2/notificaciones-correo/sync-batch', '/api/notificaciones-correo/sync-batch'],
    ['/api/v2/subledger/estado-cuenta', '/api/ledger/estado-cuenta'],
    ['/api/v2/subledger/personas/4/extracto', '/api/ledger/personas/4/extracto'],
    ['/api/v2/dashboard/flujo-caja?mes=10', '/api/analytics/flujo-caja?mes=10'],
    ['/api/v2/plantillas-recurrentes', '/api/recurrentes/plantillas'],
    ['/api/v2/plantillas-recurrentes/2', '/api/recurrentes/plantillas/2'],
    ['/api/v2/periodos-recurrentes', '/api/recurrentes/periodos'],
    ['/api/v2/periodos-recurrentes/proyectar', '/api/recurrentes/proyectar-mes'],
    ['/api/v2/periodos-recurrentes/9/registrar-pago', '/api/recurrentes/periodos/9/pagar'],
    ['/api/v2/obligaciones-mes/1/dias', '/api/obligaciones-mes/1/dias'],
  ])('%s → %s', (entrada, salida) => {
    expect(reescribirAliasV2(entrada)).toBe(salida);
  });

  it('las rutas actuales y las del legacy no se tocan', () => {
    for (const url of ['/api/compras-credito/1', '/api/tarjetas', '/api/recurrentes/plantillas', '/api/v2x/otra', '/health']) {
      expect(reescribirAliasV2(url)).toBe(url);
    }
  });
});

// ───────────────────────────── conciliar (extendido) ─────────────────────────────

describe('NotificacionesCorreoService.conciliar — compras de TC, préstamos y responsables', () => {
  function setup() {
    const prisma = createPrismaMock();
    const compras = {
      cambiarNumeroCuotasTx: jest.fn(async (_tx: any, id: bigint, n: number) => ({ id, concepto: 'EXITO', numero_cuotas: n, valor_compra: dec('50000') })),
      deleteTx: jest.fn(),
      saveTx: jest.fn().mockResolvedValue(600),
    };
    const responsables = { createTx: jest.fn() };
    const prestamos = { createTx: jest.fn().mockResolvedValue(31) };
    const transacciones = { insertar: jest.fn() };
    const service = new NotificacionesCorreoService(
      prisma,
      transacciones as any,
      compras as any,
      responsables as any,
      prestamos as any,
      { get: () => undefined } as any,
    );
    prisma.notificacionesCorreo.update.mockImplementation(async ({ data }: any) => ({ id: 9n, ...data }));
    prisma.comprasCredito.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, numero_cuotas: 1, valor_compra: dec('50000'), ...data }));
    return { prisma, service, compras, responsables, prestamos, transacciones };
  }

  const notificacion = (extra: Record<string, unknown> = {}) => ({
    id: 9n,
    owner_user_id: OWNER,
    external_message_id: '<abc>',
    estado_procesamiento: 'PENDIENTE',
    transaccion_generada_id: null,
    compra_credito_generada_id: 500n,
    fecha_correo: new Date('2026-10-13T19:00:00Z'),
    asunto: 'Compra EXITO',
    datos_parseados: { monto: '50000', moneda: 'COP', comercio: 'EXITO', ultimos_4: '1927', instrumento: 'TC', fecha: '2026-10-13' },
    ...extra,
  });
  const compraActual = { id: 500n, concepto: 'EXITO', numero_cuotas: 1, valor_compra: dec('50000'), owner_user_id: OWNER };

  it('compra importada: cambia el número de cuotas (Regla 4), el concepto y asigna responsables con montos decimales', async () => {
    const { prisma, service, compras, responsables } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    prisma.responsablesComprasCredito.findMany.mockResolvedValue([{ porcentaje_pago: dec('40') }]);

    const r = await service.conciliar(
      9,
      { accion: 'CONFIRMAR', concepto: 'Mercado', numeroCuotas: 6, responsables: [{ personaId: 2, porcentajePago: 33.33 }] },
      OWNER,
    );

    expect(prisma.comprasCredito.update.mock.calls[0][0]).toMatchObject({ where: { id: 500n }, data: { concepto: 'Mercado' } });
    expect(compras.cambiarNumeroCuotasTx).toHaveBeenCalledWith(prisma, 500n, 6, OWNER);
    // 50000 × 33.33 % = 16665 (como texto: no se pierde precisión con number)
    expect(responsables.createTx).toHaveBeenCalledWith(
      prisma,
      { persona: 2, porcentajePago: '33.33', cantidadPago: '16665', cantidadCuotas: 6, compraCredito: 500 },
      OWNER,
    );
    expect(r.responsablesCreados).toBe(1);
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toMatchObject({ estado_procesamiento: 'CONCILIADO', compra_credito_generada_id: 500n });
  });

  it('responsables cuya suma (con los existentes) supera 100 % → 400 y no se crea ninguno', async () => {
    const { prisma, service, responsables } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    prisma.responsablesComprasCredito.findMany.mockResolvedValue([{ porcentaje_pago: dec('70') }]);

    await expect(
      service.conciliar(9, { accion: 'CONFIRMAR', responsables: [{ personaId: 2, porcentajePago: 20 }, { personaId: 3, porcentajePago: 20 }] }, OWNER),
    ).rejects.toMatchObject({ status: 400 });
    expect(responsables.createTx).not.toHaveBeenCalled();
  });

  it('no permite editar el monto de una compra importada', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', monto: 1000 }, OWNER)).rejects.toMatchObject({ status: 400 });
  });

  it('mismo número de cuotas → no recalcula nada', async () => {
    const { prisma, service, compras } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    await service.conciliar(9, { accion: 'CONFIRMAR', numeroCuotas: 1 }, OWNER);
    expect(compras.cambiarNumeroCuotasTx).not.toHaveBeenCalled();
  });

  it('sin tarjeta identificada: tarjetaId crea la compra a 1 cuota y la enlaza a la notificación', async () => {
    const { prisma, service, compras } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null }));
    prisma.tarjetas.findFirst.mockResolvedValue({ tipo_tarjeta: 'CREDITO', cuenta_id: null });
    prisma.comprasCredito.findUniqueOrThrow.mockResolvedValue({ id: 600n, concepto: 'EXITO', numero_cuotas: 1, valor_compra: dec('50000') });

    const r = await service.conciliar(9, { accion: 'CONFIRMAR', tarjetaId: 10 }, OWNER);

    const entrada = compras.saveTx.mock.calls[0][1];
    expect(entrada).toMatchObject({ concepto: 'EXITO', numeroCuotas: 1, tarjeta: 10n, estado: 'Pendiente', valorCompra: '50000' });
    expect(entrada.fechaCompra.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(r.compra?.id).toBe(600n);
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toMatchObject({ compra_credito_generada_id: 600n });
  });

  it('selector unificado: una tarjeta de DÉBITO registra el movimiento en su cuenta (no crea una compra)', async () => {
    const { prisma, service, compras, transacciones } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null, datos_parseados: { monto: '50000', moneda: 'COP', comercio: 'EXITO', ultimos_4: '7992' } }));
    prisma.tarjetas.findFirst.mockResolvedValue({ tipo_tarjeta: 'DEBITO', cuenta_id: 3n });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    transacciones.insertar.mockResolvedValue({ id: 70n });

    const r = await service.conciliar(9, { accion: 'CONFIRMAR', tarjetaId: 12 }, OWNER);

    expect(compras.saveTx).not.toHaveBeenCalled();
    expect(transacciones.insertar.mock.calls[0][1]).toMatchObject({ cuentaOrigenId: 3, tipoTransaccion: 'EGRESO', montoOriginal: '50000' });
    expect(r.transaccion?.id).toBe(70n);
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toMatchObject({ transaccion_generada_id: 70n });
  });

  it('selector unificado: débito sin cuenta → 400 que lo explica; tarjeta ajena o inexistente → 404', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null }));
    prisma.tarjetas.findFirst.mockResolvedValueOnce({ tipo_tarjeta: 'DEBITO', cuenta_id: null });
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', tarjetaId: 12 }, OWNER)).rejects.toMatchObject({ status: 400, response: { errors: { tarjetaId: [expect.stringContaining('cuenta')] } } });
    prisma.tarjetas.findFirst.mockResolvedValueOnce(null);
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', tarjetaId: 99 }, OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it('correo en dólares sin tasa: pide la TRM (campo tasaCambio) y con ella crea el movimiento', async () => {
    const { prisma, service, transacciones } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null, datos_parseados: { monto: '49.99', moneda: 'USD', comercio: 'NETFLIX' } }));
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    transacciones.insertar.mockResolvedValue({ id: 71n });

    await expect(service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3 }, OWNER)).rejects.toMatchObject({ status: 400, response: { errors: { tasaCambio: [expect.stringContaining('TRM')] } } });
    expect(transacciones.insertar).not.toHaveBeenCalled();

    await service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3, tasaCambio: '4100.50' }, OWNER);
    expect(transacciones.insertar.mock.calls[0][1]).toMatchObject({ monedaOriginal: 'USD', montoOriginal: '49.99', tasaCambio: '4100.5' });
  });

  it('fecha corregida: el movimiento nuevo usa ese día (conserva la hora del correo si es el mismo día) y la compra nueva también', async () => {
    const { prisma, service, compras, transacciones } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    transacciones.insertar.mockResolvedValue({ id: 72n });
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null, datos_parseados: { monto: '50000', moneda: 'COP', comercio: 'EXITO' } }));

    // el correo llegó el 13/10 14:00 en Bogotá (19:00Z): el mismo día conserva la hora; otro día usa el mediodía de Bogotá
    await service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3, fecha: '2026-10-13' }, OWNER);
    expect(transacciones.insertar.mock.calls[0][1].fechaTransaccion.toISOString()).toBe('2026-10-13T19:00:00.000Z');
    await service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3, fecha: '2026-10-11' }, OWNER);
    expect(transacciones.insertar.mock.calls[1][1].fechaTransaccion.toISOString()).toBe('2026-10-11T17:00:00.000Z');

    prisma.tarjetas.findFirst.mockResolvedValue({ tipo_tarjeta: 'CREDITO', cuenta_id: null });
    prisma.comprasCredito.findUniqueOrThrow.mockResolvedValue({ id: 600n, concepto: 'EXITO', numero_cuotas: 1, valor_compra: dec('50000') });
    await service.conciliar(9, { accion: 'CONFIRMAR', tarjetaId: 10, fecha: '2026-10-11' }, OWNER);
    expect(compras.saveTx.mock.calls[0][1].fechaCompra.toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });

  it('fecha inexistente → 400; en un movimiento o compra ya registrados la fecha no se edita', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null }));
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3, fecha: '2026-02-31' }, OWNER)).rejects.toMatchObject({ status: 400, response: { errors: { fecha: [expect.any(String)] } } });

    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', fecha: '2026-10-11' }, OWNER)).rejects.toMatchObject({ status: 400, response: { errors: { fecha: [expect.any(String)] } } });
  });

  it('DESCARTAR elimina la compra importada (y sus cuotas) y marca IGNORADO', async () => {
    const { prisma, service, compras } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.comprasCredito.findFirst.mockResolvedValue(compraActual);
    const r = await service.conciliar(9, { accion: 'DESCARTAR' }, OWNER);
    expect(compras.deleteTx).toHaveBeenCalledWith(prisma, 500, OWNER);
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toEqual({ estado_procesamiento: 'IGNORADO' });
    expect(r.compra).toBeNull();
  });

  it('convertirEnPrestamo: el egreso confirmado origina un préstamo POR_COBRAR con el monto exacto', async () => {
    const { prisma, service, prestamos } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null, transaccion_generada_id: 77n }));
    const egreso = {
      id: 77n,
      tipo_transaccion: 'EGRESO',
      moneda_original: 'COP',
      estado: 'PENDIENTE_REVISION',
      monto_cop: dec('120000.5'),
      concepto: 'Almuerzo equipo',
      fecha_transaccion: new Date('2026-10-13T19:00:00Z'),
    };
    prisma.transacciones.findFirst.mockResolvedValue(egreso);
    prisma.transacciones.update.mockImplementation(async ({ data }: any) => ({ ...egreso, ...data }));

    const r = await service.conciliar(
      9,
      { accion: 'CONFIRMAR', convertirEnPrestamo: { responsableId: 3, fechaCobro: '2026-11-01', comentarios: 'te lo cobro' } },
      OWNER,
    );

    expect(prestamos.createTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        valorPrestado: '120000.5',
        concepto: 'Almuerzo equipo',
        responsable: 3,
        fechaCobro: '2026-11-01',
        fechaPrestamo: '2026-10-13',
        estado: 'Pendiente',
        comentarios: 'te lo cobro · Originado en la transacción #77',
      }),
      OWNER,
    );
    expect(r.prestamoId).toBe(31);
  });

  it('convertirEnPrestamo sobre un ingreso → 400 y no crea el préstamo', async () => {
    const { prisma, service, prestamos } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ compra_credito_generada_id: null, transaccion_generada_id: 77n }));
    const ingreso = { id: 77n, tipo_transaccion: 'INGRESO', moneda_original: 'COP', monto_cop: dec('1000'), concepto: 'x', fecha_transaccion: new Date() };
    prisma.transacciones.findFirst.mockResolvedValue(ingreso);
    prisma.transacciones.update.mockResolvedValue(ingreso);
    await expect(service.conciliar(9, { accion: 'CONFIRMAR', convertirEnPrestamo: { responsableId: 3 } }, OWNER)).rejects.toMatchObject({ status: 400 });
    expect(prestamos.createTx).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── aprobación por persona ─────────────────────────────

describe('PrestamosService.resolverAprobacionPorPersona', () => {
  function setup() {
    const prisma = createPrismaMock();
    const service = new PrestamosService(prisma);
    const resolver = jest.spyOn(service, 'resolverAprobacion').mockResolvedValue({ ok: true } as any);
    return { prisma, service, resolver };
  }
  const user = { userId: 9n, email: 'a@b.c', role: 'USER', name: null } as any;

  it('con aprobacionId lo delega tal cual', async () => {
    const { service, resolver, prisma } = setup();
    await service.resolverAprobacionPorPersona(4, { aprobacionId: 12, estado: 'Aprobado' } as any, user);
    expect(resolver).toHaveBeenCalledWith(4, 12, { estado: 'Aprobado', comentarios: undefined }, user);
    expect(prisma.personas.findFirst).not.toHaveBeenCalled();
  });

  it('sin ids busca la persona enlazada al usuario autenticado y su aprobación del préstamo', async () => {
    const { service, resolver, prisma } = setup();
    prisma.personas.findFirst.mockResolvedValue({ id: 2n });
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue({ id: 15n });
    await service.resolverAprobacionPorPersona(4, { estado: 'Rechazado', comentarios: 'no es mío' } as any, user);
    expect(prisma.personas.findFirst.mock.calls[0][0].where).toEqual({ linked_user_id: 9n });
    expect(prisma.aprobacionesPrestamos.findFirst.mock.calls[0][0].where).toEqual({ prestamo_id: 4n, persona_id: 2n });
    expect(resolver).toHaveBeenCalledWith(4, 15, { estado: 'Rechazado', comentarios: 'no es mío' }, user);
  });

  it('usuario sin persona enlazada y sin ids → 400; persona sin aprobación → 404', async () => {
    const { service, prisma } = setup();
    await expect(service.resolverAprobacionPorPersona(4, { estado: 'Aprobado' } as any, user)).rejects.toMatchObject({ status: 400 });
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue(null);
    await expect(service.resolverAprobacionPorPersona(4, { personaId: 2, estado: 'Aprobado' } as any, user)).rejects.toMatchObject({ status: 404 });
  });
});
