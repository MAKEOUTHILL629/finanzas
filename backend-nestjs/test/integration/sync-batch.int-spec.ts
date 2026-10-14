/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotificacionItemDto } from '../../src/modules/notificaciones-correo/dto/sync-batch.dto';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/** Webhook de Bancolombia (Apps Script) contra PostgreSQL real: idempotencia, ruteo, Trigger 2 y conciliación. */
describeDb('Integración BD — sync-batch de correos Bancolombia', () => {
  let s: Servicios;
  let semilla: Semilla;

  beforeAll(async () => {
    await prepararEsquema();
    s = await crearServicios();
  });
  afterAll(async () => {
    await s.prisma.$disconnect();
  });
  beforeEach(async () => {
    await vaciarTablas();
    semilla = await sembrar(s.prisma);
    // la tarjeta se identifica por los últimos 4 dígitos escritos en su descripción
    await s.prisma.tarjetas.update({ where: { id: BigInt(semilla.tarjetaId) }, data: { descripcion: 'Visa Oro *1927' } });
  });

  const item = (extra: Partial<NotificacionItemDto> = {}): NotificacionItemDto =>
    ({
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
    }) as NotificacionItemDto;

  const saldo = async (cuentaId: number) =>
    (await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(cuentaId) } })).saldo_actual.toString();

  it('lote mixto: cada correo termina en el destino correcto y el saldo lo mueve el Trigger 2', async () => {
    const r = await s.syncBatch.syncBatch(
      [
        item({ externalMessageId: '<compra>' }),
        item({ externalMessageId: '<ingreso>', tipo: 'Ingreso', metodo: 'Cuenta Ahorros', origenRaw: 'Cuenta *1234', comercio: 'NOMINA ACME', valor: '3.500.000', hora: '08:00:00' }),
        item({ externalMessageId: '<retiro>', tipo: 'Retiro', metodo: 'Cuenta Ahorros', origenRaw: 'cta *1234', comercio: 'CAJERO', valor: '200.000,50', hora: '09:00:00' }),
        item({ externalMessageId: '<desconocida>', tipo: 'Transferencia', metodo: 'Llaves', origenRaw: 'cta *0000', hora: '10:00:00' }),
        item({ externalMessageId: '<aviso>', asunto: 'Tu clave vence pronto', tipo: 'Desconocido', metodo: 'QR', esErrorParsing: true, hora: '11:00:00' }),
      ],
      semilla.userId,
    );

    expect(r).toMatchObject({ totalRecibidos: 5, nuevosInsertados: 5, yaExistentesIdempotentes: 0, errores: [] });
    expect([...r.syncedExternalIds].sort()).toEqual(['<aviso>', '<compra>', '<desconocida>', '<ingreso>', '<retiro>']);

    const estados = Object.fromEntries(
      (await s.prisma.notificacionesCorreo.findMany()).map((n) => [n.external_message_id, n.estado_procesamiento]),
    );
    expect(estados).toEqual({ '<compra>': 'PENDIENTE', '<ingreso>': 'CONCILIADO', '<retiro>': 'CONCILIADO', '<desconocida>': 'PENDIENTE', '<aviso>': 'IGNORADO' });

    // 1.000.000 + 3.500.000 − 200.000,50
    expect(await saldo(semilla.bancolombiaId)).toBe('4299999.5');
    const movimientos = await s.prisma.transacciones.findMany({ orderBy: { id: 'asc' } });
    expect(movimientos.map((t) => [t.tipo_transaccion, t.estado, t.origen_registro, t.monto_cop.toString()])).toEqual([
      ['INGRESO', 'CONFIRMADO', 'EMAIL_AUTO', '3500000'],
      ['EGRESO', 'CONFIRMADO', 'EMAIL_AUTO', '200000.5'],
    ]);
    // 08:00 hora Bogotá = 13:00 UTC
    expect(movimientos[0].fecha_transaccion.toISOString()).toBe('2026-10-13T13:00:00.000Z');

    const compra = await s.prisma.comprasCredito.findFirstOrThrow();
    expect(compra).toMatchObject({ concepto: 'EXITO', numero_cuotas: 1, tarjeta: BigInt(semilla.tarjetaId), owner_user_id: semilla.userId });
    expect(compra.valor_compra?.toString()).toBe('50000');
    const cuotas = await s.prisma.cuotasDetalle.findMany({ where: { compra: compra.id } });
    expect(cuotas).toHaveLength(1);
    expect(cuotas[0].pago_total?.toString()).toBe('50000');
    const notaCompra = await s.prisma.notificacionesCorreo.findFirstOrThrow({ where: { external_message_id: '<compra>' } });
    expect(notaCompra.compra_credito_generada_id).toBe(compra.id);
  });

  it('idempotencia: reenviar el mismo lote no duplica nada y devuelve los ids para que el Apps Script los marque', async () => {
    const lote = [
      item({ externalMessageId: '<compra>' }),
      item({ externalMessageId: '<ingreso>', tipo: 'Ingreso', metodo: 'Cuenta Ahorros', origenRaw: 'Cuenta *1234', valor: '100.000' }),
    ];
    await s.syncBatch.syncBatch(lote, semilla.userId);
    const otra = await s.syncBatch.syncBatch(lote, semilla.userId);

    expect(otra).toMatchObject({ nuevosInsertados: 0, yaExistentesIdempotentes: 2 });
    expect([...otra.syncedExternalIds].sort()).toEqual(['<compra>', '<ingreso>']);
    expect(await s.prisma.notificacionesCorreo.count()).toBe(2);
    expect(await s.prisma.transacciones.count()).toBe(1);
    expect(await s.prisma.comprasCredito.count()).toBe(1);
    expect(await saldo(semilla.bancolombiaId)).toBe('1100000'); // el ingreso se aplicó UNA vez
  });

  it('dos lotes idénticos en paralelo (reintento del Apps Script): ON CONFLICT deja exactamente una copia', async () => {
    const lote = [item({ externalMessageId: '<carrera>', tipo: 'Ingreso', metodo: 'Cuenta Ahorros', origenRaw: 'Cuenta *1234', valor: '70.000' })];
    const [a, b] = await Promise.all([s.syncBatch.syncBatch(lote, semilla.userId), s.syncBatch.syncBatch(lote, semilla.userId)]);

    expect(a.nuevosInsertados + b.nuevosInsertados).toBe(1);
    expect(a.yaExistentesIdempotentes + b.yaExistentesIdempotentes).toBe(1);
    expect(a.errores).toEqual([]);
    expect(b.errores).toEqual([]);
    expect(await s.prisma.transacciones.count()).toBe(1);
    expect(await saldo(semilla.bancolombiaId)).toBe('1070000');
  });

  it('pago de tarjeta: el débito y el abono del mismo pago (±5 min) producen UNA sola transacción', async () => {
    const debito = item({ externalMessageId: '<debito>', tipo: 'Pago', metodo: 'Pago Tarjeta', origenRaw: 'cta *1234', comercio: 'T.Cred *1927', valor: '800.000', hora: '14:02:11' });
    const abono = item({ externalMessageId: '<abono>', tipo: 'Abono Tarjeta', metodo: 'Cuenta Ahorros', origenRaw: 'T.Cred *1927', valor: '800.000', hora: '14:03:05' });

    const r = await s.syncBatch.syncBatch([abono, debito], semilla.userId);

    expect(r.errores).toEqual([]);
    const pagos = await s.prisma.transacciones.findMany();
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({ tipo_transaccion: 'PAGO_TARJETA', estado: 'CONFIRMADO', cuenta_origen_id: BigInt(semilla.bancolombiaId), tarjeta_pagada_id: BigInt(semilla.tarjetaId) });
    expect(await saldo(semilla.bancolombiaId)).toBe('200000'); // descontado una sola vez
    const notas = await s.prisma.notificacionesCorreo.findMany({ orderBy: { id: 'asc' } });
    expect(notas.map((n) => [n.estado_procesamiento, n.transaccion_generada_id])).toEqual([
      ['CONCILIADO', pagos[0].id],
      ['CONCILIADO', pagos[0].id],
    ]);
  });

  it('un pago de tarjeta de otro monto, o fuera de la ventana de 5 minutos, NO se confunde con el anterior', async () => {
    const pago = (id: string, valor: string, hora: string) =>
      item({ externalMessageId: id, tipo: 'Pago', metodo: 'Pago Tarjeta', origenRaw: 'cta *1234', comercio: 'T.Cred *1927', valor, hora });
    await s.syncBatch.syncBatch([pago('<p1>', '100.000', '10:00:00'), pago('<p2>', '100.001', '10:01:00'), pago('<p3>', '100.000', '10:30:00')], semilla.userId);
    expect(await s.prisma.transacciones.count()).toBe(3);
  });

  it('multi-tenant: las cuentas y tarjetas de otro usuario no se usan para resolver el correo', async () => {
    const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
    const r = await s.syncBatch.syncBatch(
      [item({ externalMessageId: '<ajeno>', tipo: 'Ingreso', metodo: 'Cuenta Ahorros', origenRaw: 'Cuenta *1234', valor: '9.999' })],
      otro.id, // el 1234 pertenece a Felipe
    );
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'PENDIENTE', motivo: 'cuenta_no_identificada' });
    expect(await s.prisma.transacciones.count()).toBe(0);
    expect(await saldo(semilla.bancolombiaId)).toBe('1000000');
    expect((await s.prisma.notificacionesCorreo.findFirstOrThrow()).owner_user_id).toBe(otro.id);
  });

  it('conciliar una compra importada: 6 cuotas (Regla 4) y responsables (Trigger 6) en una sola transacción', async () => {
    await s.syncBatch.syncBatch([item({ externalMessageId: '<compra>', valor: '600.000' })], semilla.userId);
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();

    const r = await s.notificaciones.conciliar(
      Number(nota.id),
      { accion: 'CONFIRMAR', concepto: 'Nevera', numeroCuotas: 6, responsables: [{ personaId: semilla.andresId, porcentajePago: 50 }] } as any,
      semilla.userId,
    );

    expect(r.notificacion.estado_procesamiento).toBe('CONCILIADO');
    expect(r.responsablesCreados).toBe(1);
    const compra = await s.prisma.comprasCredito.findFirstOrThrow();
    expect(compra).toMatchObject({ concepto: 'Nevera', numero_cuotas: 6 });
    const cuotas = await s.prisma.cuotasDetalle.findMany({ where: { compra: compra.id }, orderBy: { numero_cuota: 'asc' } });
    expect(cuotas.map((c) => Number(c.numero_cuota))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cuotas.reduce((acc, c) => acc + Number(c.aporte_capital), 0)).toBeCloseTo(600000, 2);
    const resp = await s.prisma.responsablesComprasCredito.findFirstOrThrow();
    expect(resp).toMatchObject({ persona: BigInt(semilla.andresId), compra_credito: compra.id });
    expect(resp.cantidad_pago?.toString()).toBe('300000');
    // Trigger 6: la deuda de Andrés llega al sub-ledger sin que NestJS la calcule
    expect(await s.prisma.movimientosDeudaPersona.count({ where: { persona_id: BigInt(semilla.andresId) } })).toBeGreaterThan(0);
  });

  it('conciliar un correo PENDIENTE sin cuenta: el usuario indica la cuenta y el Trigger 2 mueve el saldo', async () => {
    await s.syncBatch.syncBatch([item({ externalMessageId: '<x>', tipo: 'Transferencia', metodo: 'Llaves', origenRaw: 'cta *0000', valor: '45.000' })], semilla.userId);
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    expect(nota.estado_procesamiento).toBe('PENDIENTE');

    await s.notificaciones.conciliar(Number(nota.id), { accion: 'CONFIRMAR', cuentaId: semilla.nequiId } as any, semilla.userId);

    expect(await saldo(semilla.nequiId)).toBe('-45000');
    const despues = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    expect(despues.estado_procesamiento).toBe('CONCILIADO');
    await expect(
      s.notificaciones.conciliar(Number(nota.id), { accion: 'CONFIRMAR', cuentaId: semilla.nequiId } as any, semilla.userId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('DESCARTAR una compra importada la elimina junto con sus cuotas', async () => {
    await s.syncBatch.syncBatch([item({ externalMessageId: '<compra>' })], semilla.userId);
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    await s.notificaciones.conciliar(Number(nota.id), { accion: 'DESCARTAR' } as any, semilla.userId);
    expect(await s.prisma.comprasCredito.count()).toBe(0);
    expect(await s.prisma.cuotasDetalle.count()).toBe(0);
    expect((await s.prisma.notificacionesCorreo.findFirstOrThrow()).estado_procesamiento).toBe('IGNORADO');
  });
});
