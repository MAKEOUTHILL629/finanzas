/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  interpretarDatosParseados,
  NotificacionesCorreoService,
} from '../src/modules/notificaciones-correo/notificaciones-correo.service';
import { ComprasCreditoService } from '../src/modules/compras-credito/compras-credito.service';
import { ResponsablesService } from '../src/modules/compras-credito/responsables.service';
import { PrestamosService } from '../src/modules/prestamos/prestamos.service';
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';

/** Servicio con todas sus dependencias reales sobre el mismo Prisma falso. */
export function crearServicioCorreos(prisma: any) {
  const config = { get: () => undefined } as any;
  return new NotificacionesCorreoService(
    prisma,
    new TransaccionesService(prisma),
    new ComprasCreditoService(prisma),
    new ResponsablesService(prisma),
    new PrestamosService(prisma),
    config,
  );
}
import { createPrismaMock, dec, sqlDe } from './helpers/prisma-mock';

const OWNER = 7n;

describe('interpretarDatosParseados', () => {
  it('lee monto, moneda, últimos 4, comercio y tipo', () => {
    const r = interpretarDatosParseados({ comercio: ' EXITO ', monto: '50.000,5'.replace('.', ''), moneda: 'cop', ultimos_4: '1234', instrumento: 'CUENTA' });
    expect(r.monto?.toString()).toBe('50000.5');
    expect(r.moneda).toBe('COP');
    expect(r.ultimos4).toBe('1234');
    expect(r.comercio).toBe('EXITO');
    expect(r.tipo).toBe('EGRESO');
    expect(r.esTarjetaCredito).toBe(false);
  });

  it('INGRESO explícito, TC y últimos 4 largos', () => {
    expect(interpretarDatosParseados({ monto: 10, tipo: 'ingreso', ultimos_4: '**** 9876' }).tipo).toBe('INGRESO');
    expect(interpretarDatosParseados({ monto: 10, instrumento: 'TC' }).esTarjetaCredito).toBe(true);
    expect(interpretarDatosParseados({ monto: 10, ultimos_4: 55551234 }).ultimos4).toBe('1234');
  });

  it('monto inválido, cero o ausente → null', () => {
    expect(interpretarDatosParseados({ monto: 'abc' }).monto).toBeNull();
    expect(interpretarDatosParseados({ monto: 0 }).monto).toBeNull();
    expect(interpretarDatosParseados(undefined).monto).toBeNull();
  });
});

describe('NotificacionesCorreoService.ingestar', () => {
  const dto = {
    external_message_id: '<abc@mail.gmail.com>',
    remitente: 'alertas@bancolombia.com.co',
    asunto: 'Compra aprobada',
    fecha_correo: '2026-10-13T14:02:11Z',
    cuerpo_extraido: 'Compra por $50.000 en EXITO',
    datos_parseados: { comercio: 'EXITO', monto: 50000, moneda: 'COP', ultimos_4: '1234', instrumento: 'CUENTA' },
  };

  function setup() {
    const prisma = createPrismaMock();
    const service = crearServicioCorreos(prisma);
    prisma.$queryRaw.mockResolvedValue([{ id: 9n }]); // INSERT ... RETURNING id
    prisma.cuentasFinancieras.findMany.mockResolvedValue([{ id: 3n }]);
    prisma.cuentasFinancieras.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 77n, ...data }));
    prisma.notificacionesCorreo.update.mockImplementation(async ({ data }: any) => ({ id: 9n, ...data }));
    return { prisma, service };
  }

  it('INSERT ... ON CONFLICT (external_message_id) DO NOTHING RETURNING id', async () => {
    const { prisma, service } = setup();
    await service.ingestar(dto, OWNER);
    const sql = sqlDe(prisma.$queryRaw);
    expect(sql).toContain('INSERT INTO "NotificacionesCorreo"');
    expect(sql).toContain('ON CONFLICT (external_message_id) DO NOTHING');
    expect(sql).toContain('RETURNING id');
  });

  it('correo ya procesado (idempotencia): no crea transacción y reporta duplicado', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([]); // el INSERT no devolvió id
    prisma.notificacionesCorreo.findUnique.mockResolvedValue({
      id: 4n,
      owner_user_id: OWNER,
      estado_procesamiento: 'CONCILIADO',
      transaccion_generada_id: 12n,
    });
    const r = await service.ingestar(dto, OWNER);
    expect(r).toEqual({ duplicado: true, id: 4, estadoProcesamiento: 'CONCILIADO', transaccionGeneradaId: 12 });
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });

  it('duplicado de OTRO usuario no filtra información', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.notificacionesCorreo.findUnique.mockResolvedValue({ id: 4n, owner_user_id: 99n, estado_procesamiento: 'PENDIENTE' });
    expect(await service.ingestar(dto, OWNER)).toEqual({ duplicado: true, id: null, estadoProcesamiento: null, transaccionGeneradaId: null });
  });

  it('últimos 4 dígitos coinciden con UNA cuenta → crea EGRESO EMAIL_AUTO en PENDIENTE_REVISION y lo enlaza', async () => {
    const { prisma, service } = setup();
    const r = await service.ingestar(dto, OWNER);

    expect(prisma.cuentasFinancieras.findMany.mock.calls[0][0].where).toMatchObject({
      owner_user_id: OWNER,
      ultimos_4_digitos: '1234',
    });
    const { data } = prisma.transacciones.create.mock.calls[0][0];
    expect(data).toMatchObject({
      tipo_transaccion: 'EGRESO',
      cuenta_origen_id: 3n,
      cuenta_destino_id: null,
      origen_registro: 'EMAIL_AUTO',
      estado: 'PENDIENTE_REVISION',
      concepto: 'EXITO',
    });
    expect(data.monto_cop.toString()).toBe('50000');
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toEqual({
      estado_procesamiento: 'PENDIENTE',
      transaccion_generada_id: 77n,
    });
    expect(r).toMatchObject({ duplicado: false, id: 9, transaccionGeneradaId: 77 });
  });

  it('INGRESO detectado → cuenta destino', async () => {
    const { prisma, service } = setup();
    await service.ingestar({ ...dto, datos_parseados: { ...dto.datos_parseados, tipo: 'INGRESO' } }, OWNER);
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({
      tipo_transaccion: 'INGRESO',
      cuenta_origen_id: null,
      cuenta_destino_id: 3n,
    });
  });

  it.each([
    ['sin coincidencia de cuenta', (p: any) => p.cuentasFinancieras.findMany.mockResolvedValue([]), {}],
    ['cuenta ambigua (2 coincidencias)', (p: any) => p.cuentasFinancieras.findMany.mockResolvedValue([{ id: 1n }, { id: 2n }]), {}],
    ['instrumento TC (compra con tarjeta de crédito)', () => undefined, { instrumento: 'TC' }],
    ['divisa extranjera sin tasa de cambio', () => undefined, { moneda: 'USD' }],
  ])('%s → no auto-crea la transacción (queda PENDIENTE para conciliación manual)', async (_caso, preparar, extra) => {
    const { prisma, service } = setup();
    preparar(prisma);
    const r = await service.ingestar({ ...dto, datos_parseados: { ...dto.datos_parseados, ...extra } }, OWNER);
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ duplicado: false, estadoProcesamiento: 'PENDIENTE', transaccionGeneradaId: null });
  });

  it('datos_parseados sin monto válido → estado ERROR', async () => {
    const { service } = setup();
    const r = await service.ingestar({ ...dto, datos_parseados: { comercio: 'X', ultimos_4: '1234' } }, OWNER);
    expect(r.estadoProcesamiento).toBe('ERROR');
  });
});

describe('NotificacionesCorreoService.conciliar', () => {
  function setup() {
    const prisma = createPrismaMock();
    const service = crearServicioCorreos(prisma);
    prisma.notificacionesCorreo.update.mockImplementation(async ({ data }: any) => ({ id: 9n, ...data }));
    prisma.transacciones.update.mockImplementation(async ({ data }: any) => ({ id: 77n, ...data }));
    return { prisma, service };
  }
  const notificacion = (extra: Record<string, unknown> = {}) => ({
    id: 9n,
    owner_user_id: OWNER,
    external_message_id: '<abc>',
    estado_procesamiento: 'PENDIENTE',
    transaccion_generada_id: 77n,
    fecha_correo: new Date('2026-10-13T14:00:00Z'),
    asunto: 'Compra',
    datos_parseados: { monto: 50000, ultimos_4: '1234' },
    ...extra,
  });

  it('CONFIRMAR: la transacción pasa a CONFIRMADO (el Trigger 2 impactará el saldo) y la notificación a CONCILIADO', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.transacciones.findFirst.mockResolvedValue({ id: 77n, moneda_original: 'COP', estado: 'PENDIENTE_REVISION' });
    prisma.categorias.findFirst.mockResolvedValue({ id: 5n });

    const r = await service.conciliar(9, { accion: 'CONFIRMAR', categoriaId: 5, concepto: 'Mercado' }, OWNER);

    expect(prisma.transacciones.update.mock.calls[0][0].data).toEqual({ estado: 'CONFIRMADO', categoria_id: 5n, concepto: 'Mercado' });
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toEqual({
      estado_procesamiento: 'CONCILIADO',
      transaccion_generada_id: 77n,
    });
    expect(r.notificacion.estado_procesamiento).toBe('CONCILIADO');
    expect(prisma.cuentasFinancieras.update).not.toHaveBeenCalled(); // el saldo lo mueve el Trigger 2
  });

  it('CONFIRMAR corrigiendo el monto (COP)', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.transacciones.findFirst.mockResolvedValue({ id: 77n, moneda_original: 'COP' });
    await service.conciliar(9, { accion: 'CONFIRMAR', monto: 51000.25 }, OWNER);
    const { data } = prisma.transacciones.update.mock.calls[0][0];
    expect(data.monto_cop.toString()).toBe('51000.25');
    expect(data.monto_original.toString()).toBe('51000.25');
  });

  it('CONFIRMAR sin transacción previa exige cuentaId y crea la transacción CONFIRMADA', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ transaccion_generada_id: null }));
    await expect(service.conciliar(9, { accion: 'CONFIRMAR' }, OWNER)).rejects.toMatchObject({ status: 400 });

    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 88n, ...data }));
    await service.conciliar(9, { accion: 'CONFIRMAR', cuentaId: 3 }, OWNER);
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({
      estado: 'CONFIRMADO',
      cuenta_origen_id: 3n,
      origen_registro: 'EMAIL_AUTO',
    });
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data.transaccion_generada_id).toBe(88n);
  });

  it('DESCARTAR: anula la transacción pendiente y marca IGNORADO', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion());
    prisma.transacciones.findFirst.mockResolvedValue({ id: 77n, estado: 'PENDIENTE_REVISION' });
    await service.conciliar(9, { accion: 'DESCARTAR' }, OWNER);
    expect(prisma.transacciones.update.mock.calls[0][0].data).toEqual({ estado: 'ANULADO' });
    expect(prisma.notificacionesCorreo.update.mock.calls[0][0].data).toEqual({ estado_procesamiento: 'IGNORADO' });
  });

  it('una notificación ya conciliada/ignorada no se vuelve a procesar (409)', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(notificacion({ estado_procesamiento: 'CONCILIADO' }));
    await expect(service.conciliar(9, { accion: 'CONFIRMAR' }, OWNER)).rejects.toMatchObject({ status: 409 });
    expect(prisma.transacciones.update).not.toHaveBeenCalled();
  });

  it('notificación ajena → 404', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findFirst.mockResolvedValue(null);
    await expect(service.conciliar(9, { accion: 'CONFIRMAR' }, OWNER)).rejects.toMatchObject({ status: 404 });
  });
});

void dec;
