/* eslint-disable @typescript-eslint/no-explicit-any */
import { EstadoTransaccion, TipoTransaccion } from '../../src/common/enums/finance.enums';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/** Libro diario ↔ Trigger 2 (saldo de cuentas) y bandeja de correos bancarios, en PostgreSQL real. */
describeDb('Integración BD — cuentas, transacciones y correos (Trigger 2)', () => {
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
  });

  const saldo = async (cuentaId: number) =>
    (await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(cuentaId) } })).saldo_actual.toString();

  it('cuenta nueva: saldo inicial escrito por NestJS; después SOLO lo mueve el Trigger 2', async () => {
    const cuenta = await s.cuentas.create({ nombre: 'Davivienda', tipoCuenta: 'AHORROS' as any, saldoInicial: 250000.75 }, semilla.userId);
    expect(cuenta.saldo_actual.toString()).toBe('250000.75');
    expect(cuenta.moneda).toBe('COP');
    // PATCH no puede modificar saldo_actual (el DTO no lo admite) y conserva el valor
    const editada = await s.cuentas.update(Number(cuenta.id), { nombre: 'Davivienda 2' }, semilla.userId);
    expect(editada.saldo_actual.toString()).toBe('250000.75');
  });

  it('INGRESO / EGRESO CONFIRMADOS ajustan el saldo con precisión decimal exacta', async () => {
    const base = { concepto: 'x', cuentaOrigenId: undefined as number | undefined };
    await s.transacciones.create({ ...base, tipoTransaccion: TipoTransaccion.INGRESO, cuentaDestinoId: semilla.bancolombiaId, concepto: 'Nómina', montoOriginal: 500000 }, semilla.userId);
    await s.transacciones.create({ ...base, tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Mercado', montoOriginal: 120000.5 }, semilla.userId);
    await s.transacciones.create({ ...base, tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Café', montoOriginal: 0.1 }, semilla.userId);
    await s.transacciones.create({ ...base, tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Café', montoOriginal: 0.2 }, semilla.userId);

    // 1.000.000 + 500.000 − 120.000,50 − 0,10 − 0,20 = 1.379.999,20 (con float daría 1379999.2000000002)
    expect(await saldo(semilla.bancolombiaId)).toBe('1379999.2');
  });

  it('TRANSFERENCIA = una sola fila que mueve ambas cuentas', async () => {
    await s.transacciones.create(
      { tipoTransaccion: TipoTransaccion.TRANSFERENCIA, cuentaOrigenId: semilla.bancolombiaId, cuentaDestinoId: semilla.nequiId, concepto: 'A Nequi', montoOriginal: 200000 },
      semilla.userId,
    );
    expect(await saldo(semilla.bancolombiaId)).toBe('800000');
    expect(await saldo(semilla.nequiId)).toBe('200000');
    expect(await s.prisma.transacciones.count()).toBe(1);
  });

  it('PENDIENTE_REVISION no toca el saldo hasta pasar a CONFIRMADO; anular revierte', async () => {
    const tx = await s.transacciones.create(
      { tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Compra email', montoOriginal: 50000, estado: EstadoTransaccion.PENDIENTE_REVISION },
      semilla.userId,
    );
    expect(await saldo(semilla.bancolombiaId)).toBe('1000000');

    await s.transacciones.update(Number(tx.id), { estado: EstadoTransaccion.CONFIRMADO }, semilla.userId);
    expect(await saldo(semilla.bancolombiaId)).toBe('950000');

    await s.transacciones.update(Number(tx.id), { montoOriginal: 60000 }, semilla.userId); // revierte 50k y aplica 60k
    expect(await saldo(semilla.bancolombiaId)).toBe('940000');

    const anulada = await s.transacciones.anular(Number(tx.id), semilla.userId);
    expect(anulada.estado).toBe('ANULADO');
    expect(await saldo(semilla.bancolombiaId)).toBe('1000000');
  });

  it('cambiar la cuenta de una transacción mueve el impacto entre cuentas', async () => {
    const tx = await s.transacciones.create(
      { tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'x', montoOriginal: 10000 },
      semilla.userId,
    );
    await s.transacciones.update(Number(tx.id), { cuentaOrigenId: semilla.nequiId }, semilla.userId);
    expect(await saldo(semilla.bancolombiaId)).toBe('1000000');
    expect(await saldo(semilla.nequiId)).toBe('-10000');
  });

  it('divisa extranjera: el saldo se afecta por monto_cop', async () => {
    await s.transacciones.create(
      { tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: 'Netflix', monedaOriginal: 'USD', montoOriginal: 15.99, tasaCambio: 4150.1234 },
      semilla.userId,
    );
    expect(await saldo(semilla.bancolombiaId)).toBe('933639.53'); // 1.000.000 − 66.360,47
  });

  it('list con filtros y paginación', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await s.transacciones.create(
        { tipoTransaccion: TipoTransaccion.EGRESO, cuentaOrigenId: semilla.bancolombiaId, concepto: `Gasto ${i}`, montoOriginal: i * 1000, fechaTransaccion: `2026-0${i}-15T12:00:00Z` },
        semilla.userId,
      );
    }
    const pagina = await s.transacciones.list(semilla.userId, { desde: '2026-02-01', hasta: '2026-04-30', cuentaId: semilla.bancolombiaId, limit: 2, offset: 0 });
    expect(pagina.total).toBe(3);
    expect(pagina.items.map((t) => t.concepto)).toEqual(['Gasto 4', 'Gasto 3']);
  });

  it('categorías: sistema + propias; las del sistema no se modifican', async () => {
    await s.prisma.categorias.create({ data: { owner_user_id: null, nombre: 'Mercado', tipo: 'EGRESO' } });
    const propia = await s.cuentas.createCategoria({ nombre: 'Mascotas', tipo: 'EGRESO' as any }, semilla.userId);
    const otro = await s.prisma.users.create({ data: { email: 'o@x.com', role: 'user', is_active: true } });
    await s.cuentas.createCategoria({ nombre: 'Ajena', tipo: 'EGRESO' as any }, otro.id);

    const lista = await s.cuentas.listCategorias(semilla.userId);
    expect(lista.map((c) => c.nombre).sort()).toEqual(['Mascotas', 'Mercado']);
    const sistema = lista.find((c) => c.nombre === 'Mercado');
    await expect(s.cuentas.updateCategoria(Number(sistema?.id), { nombre: 'X' }, semilla.userId)).rejects.toMatchObject({ status: 403 });
    await expect(s.cuentas.removeCategoria(Number(propia.id), semilla.userId)).resolves.toBeUndefined();
  });

  describe('NotificacionesCorreo (ingesta idempotente + conciliación)', () => {
    const correo = (id: string, extra: Record<string, unknown> = {}) => ({
      external_message_id: id,
      remitente: 'alertas@bancolombia.com.co',
      asunto: 'Compra aprobada',
      fecha_correo: '2026-10-13T14:02:11Z',
      cuerpo_extraido: 'Compra por $50.000',
      datos_parseados: { comercio: 'EXITO', monto: 50000, moneda: 'COP', ultimos_4: '1234', instrumento: 'CUENTA', ...extra },
    });

    it('ingesta: crea notificación + transacción PENDIENTE_REVISION (EMAIL_AUTO) sin tocar el saldo', async () => {
      const r = await s.notificaciones.ingestar(correo('<m1@mail>'), semilla.userId);
      expect(r).toMatchObject({ duplicado: false, estadoProcesamiento: 'PENDIENTE' });
      expect(r.transaccionGeneradaId).not.toBeNull();

      const tx = await s.prisma.transacciones.findFirstOrThrow();
      expect(tx).toMatchObject({ tipo_transaccion: 'EGRESO', origen_registro: 'EMAIL_AUTO', estado: 'PENDIENTE_REVISION', cuenta_origen_id: BigInt(semilla.bancolombiaId) });
      expect(tx.monto_cop.toString()).toBe('50000');
      expect(await saldo(semilla.bancolombiaId)).toBe('1000000');

      const n = await s.prisma.notificacionesCorreo.findFirstOrThrow();
      expect(n.transaccion_generada_id).toBe(tx.id);
      expect((n.datos_parseados as any).ultimos_4).toBe('1234'); // jsonb
      expect(n.fecha_correo.toISOString()).toBe('2026-10-13T14:02:11.000Z');
    });

    it('el mismo Message-ID no se procesa dos veces (ON CONFLICT DO NOTHING)', async () => {
      await s.notificaciones.ingestar(correo('<m1@mail>'), semilla.userId);
      const segunda = await s.notificaciones.ingestar(correo('<m1@mail>'), semilla.userId);
      expect(segunda).toMatchObject({ duplicado: true });
      expect(await s.prisma.notificacionesCorreo.count()).toBe(1);
      expect(await s.prisma.transacciones.count()).toBe(1);
    });

    it('conciliar CONFIRMAR → la transacción queda CONFIRMADO y el Trigger 2 descuenta el saldo', async () => {
      const r = await s.notificaciones.ingestar(correo('<m2@mail>'), semilla.userId);
      const categoria = await s.prisma.categorias.create({ data: { owner_user_id: semilla.userId, nombre: 'Mercado', tipo: 'EGRESO' } });

      const res = await s.notificaciones.conciliar(r.id as number, { accion: 'CONFIRMAR', categoriaId: Number(categoria.id), concepto: 'Mercado Éxito' }, semilla.userId);

      expect(res.notificacion.estado_procesamiento).toBe('CONCILIADO');
      expect(res.transaccion).toMatchObject({ estado: 'CONFIRMADO', concepto: 'Mercado Éxito', categoria_id: categoria.id });
      expect(await saldo(semilla.bancolombiaId)).toBe('950000');
      await expect(s.notificaciones.conciliar(r.id as number, { accion: 'CONFIRMAR' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });

    it('conciliar DESCARTAR → transacción ANULADO y saldo intacto', async () => {
      const r = await s.notificaciones.ingestar(correo('<m3@mail>'), semilla.userId);
      await s.notificaciones.conciliar(r.id as number, { accion: 'DESCARTAR' }, semilla.userId);
      expect((await s.prisma.transacciones.findFirstOrThrow()).estado).toBe('ANULADO');
      expect(await saldo(semilla.bancolombiaId)).toBe('1000000');
    });

    it('sin cuenta identificable queda PENDIENTE; luego se concilia indicando la cuenta', async () => {
      const r = await s.notificaciones.ingestar(correo('<m4@mail>', { ultimos_4: '9999', tipo: 'INGRESO' }), semilla.userId);
      expect(r.transaccionGeneradaId).toBeNull();
      const res = await s.notificaciones.conciliar(r.id as number, { accion: 'CONFIRMAR', cuentaId: semilla.nequiId }, semilla.userId);
      expect(res.transaccion).toMatchObject({ tipo_transaccion: 'INGRESO', estado: 'CONFIRMADO', cuenta_destino_id: BigInt(semilla.nequiId) });
      expect(await saldo(semilla.nequiId)).toBe('50000');
    });
  });
});
