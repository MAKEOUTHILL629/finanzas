/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { ComprasCreditoService } from '../src/modules/compras-credito/compras-credito.service';
import { NotificacionItemDto, parseSyncBatchBody } from '../src/modules/notificaciones-correo/dto/sync-batch.dto';
import { SyncBatchService } from '../src/modules/notificaciones-correo/sync-batch.service';
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 1n;

function item(extra: Partial<NotificacionItemDto> = {}): NotificacionItemDto {
  return {
    externalMessageId: '<m1@mail>',
    fecha: '2026-10-13',
    hora: '14:02:11',
    tipo: 'Compra',
    metodo: 'Tarjeta Credito',
    comercio: 'EXITO',
    origenRaw: 'T.Cred *1927',
    valor: '50.000',
    moneda: 'COP',
    ...extra,
  } as NotificacionItemDto;
}

const CUENTAS = [
  { id: 1n, ultimos_4_digitos: '3698', moneda: 'COP' },
  { id: 2n, ultimos_4_digitos: '4248, 4278', moneda: 'COP' },
];
const TARJETAS = [
  { id: 10n, descripcion: 'Visa Oro *1927', franquicia: 'Visa', tasa_interes_compra: dec('1.8895'), tasa_interes_avance: dec('2.1') },
  { id: 11n, descripcion: 'Mastercard 9491', franquicia: 'Mastercard', tasa_interes_compra: null, tasa_interes_avance: null },
];

function setup(config: Record<string, unknown> = {}) {
  const prisma = createPrismaMock();
  const configService = { get: (k: string) => ({ SYNC_TZ_OFFSET: '-05:00', ...config })[k] } as unknown as ConfigService;
  const service = new SyncBatchService(prisma, new ComprasCreditoService(prisma), new TransaccionesService(prisma), configService);

  let idNotificacion = 100n;
  prisma.$queryRaw.mockImplementation(async () => [{ id: idNotificacion++ }]); // INSERT ... RETURNING id
  prisma.cuentasFinancieras.findMany.mockResolvedValue(CUENTAS);
  prisma.cuentasFinancieras.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
  prisma.tarjetas.findMany.mockResolvedValue(TARJETAS);
  prisma.tarjetas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id, dia_corte: null }));
  prisma.comprasCredito.create.mockResolvedValue({ id: 500n });
  prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 900n, ...data }));
  prisma.notificacionesCorreo.update.mockResolvedValue({});
  return { prisma, service };
}

const estadoFinal = (prisma: any, llamada = 0) => prisma.notificacionesCorreo.update.mock.calls[llamada][0].data;

describe('SyncBatchService — idempotencia', () => {
  it('ids que ya existen no se vuelven a insertar y se reportan como sincronizados', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findMany.mockResolvedValue([{ external_message_id: '<viejo@mail>' }]);

    const r = await service.syncBatch([item({ externalMessageId: '<viejo@mail>' }), item({ externalMessageId: '<nuevo@mail>' })], OWNER);

    expect(r).toMatchObject({ totalRecibidos: 2, nuevosInsertados: 1, yaExistentesIdempotentes: 1 });
    expect(r.syncedExternalIds.sort()).toEqual(['<nuevo@mail>', '<viejo@mail>']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // solo el nuevo
  });

  it('un lote totalmente repetido no abre ni una transacción', async () => {
    const { prisma, service } = setup();
    prisma.notificacionesCorreo.findMany.mockResolvedValue([{ external_message_id: '<a>' }, { external_message_id: '<b>' }]);
    const r = await service.syncBatch([item({ externalMessageId: '<a>' }), item({ externalMessageId: '<b>' })], OWNER);
    expect(r).toMatchObject({ nuevosInsertados: 0, yaExistentesIdempotentes: 2, syncedExternalIds: ['<a>', '<b>'] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.cuentasFinancieras.findMany).not.toHaveBeenCalled();
  });

  it('el mismo id dos veces en el lote cuenta una vez como nuevo y otra como idempotente', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([item({ externalMessageId: '<dup>' }), item({ externalMessageId: '<dup>' })], OWNER);
    expect(r).toMatchObject({ nuevosInsertados: 1, yaExistentesIdempotentes: 1 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('si el INSERT ... ON CONFLICT no devuelve id (carrera) el ítem se trata como idempotente', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    const r = await service.syncBatch([item()], OWNER);
    expect(r).toMatchObject({ nuevosInsertados: 0, yaExistentesIdempotentes: 1, syncedExternalIds: ['<m1@mail>'] });
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
  });
});

describe('SyncBatchService — enrutamiento', () => {
  it('avisos informativos y errores de parseo → IGNORADO, sin tocar compras ni transacciones', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch(
      [
        item({ externalMessageId: '<a>', asunto: 'Tu tarjeta se vence el 20 de octubre' }),
        item({ externalMessageId: '<b>', esErrorParsing: true, tipo: 'Desconocido', metodo: 'QR' }),
      ],
      OWNER,
    );
    expect(r.nuevosInsertados).toBe(2);
    expect(prisma.notificacionesCorreo.update.mock.calls.map((c: any) => c[0].data.estado_procesamiento)).toEqual(['IGNORADO', 'IGNORADO']);
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });

  it('Compra con Tarjeta Credito → ComprasCredito a 1 cuota + cuota, notificación PENDIENTE enlazada a la compra', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([item()], OWNER);

    expect(r.detalle[0]).toMatchObject({ ruta: 'COMPRA_TC', estadoProcesamiento: 'PENDIENTE', compraCreditoId: 500 });
    const compra = prisma.comprasCredito.create.mock.calls[0][0].data;
    expect(compra).toMatchObject({ concepto: 'EXITO', numero_cuotas: 1, tarjeta: 10n, owner_user_id: OWNER, estado: 'Pendiente', moneda_original: 'COP' });
    expect(compra.valor_compra.toString()).toBe('50000'); // "50.000" = cincuenta mil pesos
    expect(compra.interes.toString()).toBe('1.8895'); // tasa de compra de la tarjeta
    expect(compra.fecha_compra.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    const cuotas = prisma.cuotasDetalle.createMany.mock.calls[0][0].data;
    expect(cuotas).toHaveLength(1);
    expect(cuotas[0].pago_total.toString()).toBe('50000');
    expect(estadoFinal(prisma)).toMatchObject({ estado_procesamiento: 'PENDIENTE', compra_credito_generada_id: 500n, transaccion_generada_id: null });
    expect(prisma.responsablesComprasCredito.create).not.toHaveBeenCalled(); // el usuario los asigna al conciliar
  });

  it('Avance usa la tasa de avance y lo marca en el concepto', async () => {
    const { prisma, service } = setup();
    await service.syncBatch([item({ tipo: 'Avance', comercio: 'CAJERO ATH' })], OWNER);
    const compra = prisma.comprasCredito.create.mock.calls[0][0].data;
    expect(compra.concepto).toBe('Avance - CAJERO ATH');
    expect(compra.interes.toString()).toBe('2.1');
  });

  it('compra con tarjeta sin identificar → PENDIENTE sin crear nada (motivo registrado)', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([item({ origenRaw: 'T.Cred *0000' })], OWNER);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'PENDIENTE', motivo: 'tarjeta_no_identificada', compraCreditoId: null });
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
    expect(estadoFinal(prisma).datos_parseados).toMatchObject({ motivo: 'tarjeta_no_identificada', ultimos_4: '0000', instrumento: 'TC' });
  });

  it('compra en USD usa la TRM de la última compra en USD; sin TRM queda PENDIENTE', async () => {
    const sinTrm = setup();
    const r1 = await sinTrm.service.syncBatch([item({ valor: '49.99', moneda: 'USD' })], OWNER);
    expect(r1.detalle[0]).toMatchObject({ estadoProcesamiento: 'PENDIENTE', motivo: 'trm_no_disponible' });
    expect(sinTrm.prisma.comprasCredito.create).not.toHaveBeenCalled();

    const conTrm = setup();
    conTrm.prisma.comprasCredito.findFirst.mockResolvedValue({ tasa_cambio_aplicada: dec('4200') });
    await conTrm.service.syncBatch([item({ valor: '49.99', moneda: 'USD' })], OWNER);
    const compra = conTrm.prisma.comprasCredito.create.mock.calls[0][0].data;
    expect(compra).toMatchObject({ moneda_original: 'USD', trm_confirmada: false });
    expect(compra.valor_moneda_original.toString()).toBe('49.99');
    expect(compra.tasa_cambio_aplicada.toString()).toBe('4200');
    expect(compra.valor_compra.toString()).toBe('209958'); // 49.99 × 4200

    const respaldo = setup({ DEFAULT_TRM_USD: '4000.5' });
    await respaldo.service.syncBatch([item({ valor: '10', moneda: 'USD' })], OWNER);
    expect(respaldo.prisma.comprasCredito.create.mock.calls[0][0].data.tasa_cambio_aplicada.toString()).toBe('4000.5');
  });

  it('Ingreso / Pago Proveedor → INGRESO CONFIRMADO en la cuenta destino (EMAIL_AUTO)', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch(
      [item({ tipo: 'Ingreso', metodo: 'Cuenta Ahorros', origenRaw: 'Cuenta *3698', comercio: 'NOMINA ACME', valor: '3.500.000' })],
      OWNER,
    );
    expect(r.detalle[0]).toMatchObject({ ruta: 'INGRESO', estadoProcesamiento: 'CONCILIADO', transaccionId: 900 });
    const tx = prisma.transacciones.create.mock.calls[0][0].data;
    expect(tx).toMatchObject({
      tipo_transaccion: 'INGRESO',
      cuenta_destino_id: 1n,
      cuenta_origen_id: null,
      origen_registro: 'EMAIL_AUTO',
      estado: 'CONFIRMADO',
      concepto: 'NOMINA ACME',
    });
    expect(tx.monto_cop.toString()).toBe('3500000');
    // 14:02:11 hora de Bogotá = 19:02:11 UTC
    expect(tx.fecha_transaccion.toISOString()).toBe('2026-10-13T19:02:11.000Z');
    expect(estadoFinal(prisma)).toMatchObject({ estado_procesamiento: 'CONCILIADO', transaccion_generada_id: 900n });
  });

  it.each([
    ['Transferencia', 'Cuenta Ahorros/Corriente', 'cta *3698', 1n],
    ['Pago', 'QR', 'Cuenta *4248', 2n],
    ['Retiro', 'Cuenta Ahorros', 'producto *3698', 1n],
    ['Compra', 'Tarjeta Debito', '*4278', 2n], // tarjeta débito registrada junto a la cuenta
  ])('%s / %s (%s) → EGRESO CONFIRMADO desde la cuenta %s', async (tipo, metodo, origenRaw, cuentaEsperada) => {
    const { prisma, service } = setup();
    await service.syncBatch([item({ tipo, metodo, origenRaw, valor: '12.500' })], OWNER);
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({
      tipo_transaccion: 'EGRESO',
      cuenta_origen_id: cuentaEsperada,
      cuenta_destino_id: null,
      estado: 'CONFIRMADO',
      origen_registro: 'EMAIL_AUTO',
    });
  });

  it('cuenta no identificada o combinación desconocida → PENDIENTE, sin crear movimientos', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch(
      [
        item({ externalMessageId: '<a>', tipo: 'Transferencia', metodo: 'Llaves', origenRaw: 'cta *0000' }),
        item({ externalMessageId: '<b>', tipo: 'Desconocido', metodo: 'QR', origenRaw: 'cta *3698' }),
      ],
      OWNER,
    );
    expect(r.detalle.map((d) => d.motivo)).toEqual(['cuenta_no_identificada', 'tipo_o_metodo_no_reconocido']);
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });

  it('monto inválido o fecha inválida → notificación ERROR persistida (no se reintenta eternamente)', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch(
      [item({ externalMessageId: '<a>', tipo: 'Ingreso', origenRaw: 'cta *3698', valor: 'abc' }), item({ externalMessageId: '<b>', tipo: 'Ingreso', origenRaw: 'cta *3698', fecha: '2026-13-45' })],
      OWNER,
    );
    const por = (id: string) => r.detalle.find((d) => d.externalMessageId === id);
    expect(por('<a>')).toMatchObject({ estadoProcesamiento: 'ERROR', motivo: 'monto_invalido' });
    expect(por('<b>')).toMatchObject({ estadoProcesamiento: 'ERROR', motivo: 'fecha_u_hora_invalida' });
    expect([...r.syncedExternalIds].sort()).toEqual(['<a>', '<b>']);
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });
});

describe('SyncBatchService — pago de tarjeta (deduplicación ±5 min)', () => {
  const debito = () => item({ externalMessageId: '<debito>', tipo: 'Pago', metodo: 'Pago Tarjeta', origenRaw: 'cta *3698', comercio: 'T.Cred *1927', valor: '800.000' });
  const abono = () => item({ externalMessageId: '<abono>', tipo: 'Abono Tarjeta', metodo: 'Cuenta Ahorros', origenRaw: 'T.Cred *1927', valor: '800.000', hora: '14:02:40' });

  it('el débito en cuenta crea la transacción PAGO_TARJETA, con la tarjeta identificada por el comercio', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([debito()], OWNER);
    expect(r.detalle[0]).toMatchObject({ ruta: 'PAGO_TARJETA', estadoProcesamiento: 'CONCILIADO' });
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({
      tipo_transaccion: 'PAGO_TARJETA',
      cuenta_origen_id: 1n,
      tarjeta_pagada_id: 10n,
      estado: 'CONFIRMADO',
    });
    // se buscó un duplicado en la ventana ±5 min por el mismo monto
    const where = prisma.transacciones.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ owner_user_id: OWNER, tipo_transaccion: 'PAGO_TARJETA', estado: { not: 'ANULADO' } });
    expect(where.monto_cop.toString()).toBe('800000');
    expect(where.fecha_transaccion.gte.toISOString()).toBe('2026-10-13T18:57:11.000Z');
    expect(where.fecha_transaccion.lte.toISOString()).toBe('2026-10-13T19:07:11.000Z');
  });

  it('si ya existe un PAGO_TARJETA del mismo monto en la ventana, el correo se enlaza y NO duplica', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findFirst.mockResolvedValue({ id: 77n, tarjeta_pagada_id: null });
    const r = await service.syncBatch([abono()], OWNER);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'CONCILIADO', transaccionId: 77, motivo: 'duplicado_de_pago_tarjeta_existente' });
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
    // el abono aporta la tarjeta que el débito no traía
    expect(prisma.transacciones.update).toHaveBeenCalledWith({ where: { id: 77n }, data: { tarjeta_pagada_id: 10n } });
  });

  it('abono sin débito previo y sin cuenta identificable → PENDIENTE (no inventa una cuenta)', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([abono()], OWNER);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'PENDIENTE', motivo: 'cuenta_origen_no_identificada' });
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });

  it('en un lote, el débito se procesa antes que el abono aunque lleguen invertidos (un solo pago)', async () => {
    const { prisma, service } = setup();
    // simula que el segundo findFirst (abono) encuentra la transacción creada por el débito
    prisma.transacciones.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 900n, tarjeta_pagada_id: 10n });
    const r = await service.syncBatch([abono(), debito()], OWNER);
    expect(r.detalle.map((d) => d.externalMessageId)).toEqual(['<debito>', '<abono>']);
    expect(prisma.transacciones.create).toHaveBeenCalledTimes(1);
    expect(r.detalle[1]).toMatchObject({ transaccionId: 900, motivo: 'duplicado_de_pago_tarjeta_existente' });
  });

  it('pago sin tarjeta identificable igual descuenta la cuenta (relaja la regla de PAGO_TARJETA)', async () => {
    const { prisma, service } = setup();
    const r = await service.syncBatch([item({ ...debito(), comercio: 'Pago T.Cred', origenRaw: 'cta *3698' })], OWNER);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'CONCILIADO', motivo: 'pago_tarjeta_sin_tarjeta_identificada' });
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({ tarjeta_pagada_id: null, cuenta_origen_id: 1n });
  });
});

describe('SyncBatchService — aislamiento de errores y multi-tenant', () => {
  it('un ítem que falla se revierte y se reporta; no entra a syncedExternalIds y los demás continúan', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.create.mockRejectedValueOnce(new Error('conexión perdida')).mockResolvedValue({ id: 901n });
    const r = await service.syncBatch(
      [
        item({ externalMessageId: '<falla>', tipo: 'Ingreso', origenRaw: 'cta *3698' }),
        item({ externalMessageId: '<ok>', tipo: 'Ingreso', origenRaw: 'cta *3698', hora: '15:00:00' }),
      ],
      OWNER,
    );
    expect(r.errores).toEqual([{ externalMessageId: '<falla>', error: 'conexión perdida' }]);
    expect(r.syncedExternalIds).toEqual(['<ok>']);
    expect(r.nuevosInsertados).toBe(1);
    expect(r.detalle.find((d) => d.externalMessageId === '<falla>')).toMatchObject({ resultado: 'ERROR' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // una transacción por ítem
  });

  it('solo carga y usa cuentas y tarjetas del usuario propietario', async () => {
    const { prisma, service } = setup();
    await service.syncBatch([item()], 7n);
    expect(prisma.cuentasFinancieras.findMany.mock.calls[0][0].where.owner_user_id).toBe(7n);
    expect(prisma.tarjetas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: 7n });
    expect(prisma.tarjetas.findFirst.mock.calls[0][0].where.owner_user_id).toBe(7n); // saveTx verifica la propiedad
    expect(prisma.comprasCredito.create.mock.calls[0][0].data.owner_user_id).toBe(7n);
  });

  it('guarda el correo completo (datos_parseados) para auditar y conciliar', async () => {
    const { prisma, service } = setup();
    await service.syncBatch([item({ linkCorreo: 'https://mail.google.com/x', cuerpoExtraido: 'Compra por $50.000' })], OWNER);
    expect(estadoFinal(prisma).datos_parseados).toMatchObject({
      tipo: 'Compra',
      metodo: 'Tarjeta Credito',
      comercio: 'EXITO',
      moneda: 'COP',
      ultimos_4: '1927',
      instrumento: 'TC',
      ruta: 'COMPRA_TC',
      monto: '50000',
      fecha: '2026-10-13',
      hora: '14:02:11',
      linkCorreo: 'https://mail.google.com/x',
    });
  });
});

describe('parseSyncBatchBody', () => {
  const crudo = { externalMessageId: '<a>', fecha: '2026-10-13', hora: '14:02:11', tipo: 'Compra', metodo: 'QR', valor: '1.000', moneda: 'COP' };

  it('acepta { items }, { notificaciones } y un arreglo directo', () => {
    expect(parseSyncBatchBody({ items: [crudo] })).toHaveLength(1);
    expect(parseSyncBatchBody({ notificaciones: [crudo] })).toHaveLength(1);
    expect(parseSyncBatchBody([crudo, { ...crudo, externalMessageId: '<b>' }])).toHaveLength(2);
    expect(parseSyncBatchBody({ items: [] })).toEqual([]);
  });

  it('valor numérico, moneda por defecto y campos opcionales ausentes', () => {
    const [i] = parseSyncBatchBody([{ ...crudo, valor: 50000, moneda: undefined }]);
    expect(i.valor).toBe(50000);
  });

  it('rechaza con 400 indicando qué ítem y qué campo fallan', () => {
    try {
      parseSyncBatchBody({ items: [crudo, { ...crudo, externalMessageId: '<x>', fecha: '13/10/2026', moneda: 'EUR' }] });
      fail('debía lanzar');
    } catch (e: any) {
      expect(e.status).toBe(400);
      const errores = e.getResponse().errors;
      expect(Object.keys(errores)).toEqual(['items[1] (<x>)']);
      expect(errores['items[1] (<x>)'].join(' ')).toContain('fecha debe tener formato YYYY-MM-DD');
    }
  });

  it('rechaza cuerpos que no son lotes y lotes demasiado grandes', () => {
    expect(() => parseSyncBatchBody({})).toThrow();
    expect(() => parseSyncBatchBody('hola')).toThrow();
    expect(() => parseSyncBatchBody(Array.from({ length: 501 }, (_, i) => ({ ...crudo, externalMessageId: `<${i}>` })))).toThrow();
  });
});
