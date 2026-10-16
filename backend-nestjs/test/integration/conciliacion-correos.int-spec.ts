/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Client } from 'pg';
import { ConciliarCorreoDto } from '../../src/modules/notificaciones-correo/dto/notificacion.dto';
import { AsignarProductoDto } from '../../src/modules/notificaciones-correo/dto/productos-correo.dto';
import { TEST_DATABASE_URL, crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Conciliación de correos (fase 3 del plan V2): un selector único de producto (tarjeta de crédito, de débito o cuenta), la TRM de los
 * correos en dólares, cuerpos con campos vacíos y la sugerencia de un plástico que ya existía (antes «aceptar» no hacía nada).
 */
describeDb('Integración BD — conciliación de correos', () => {
  let s: Servicios;
  let semilla: Semilla;
  let debito: bigint;

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
    // Tarjeta de débito de la cuenta «Bancolombia» (1234), con un plástico activo *7992
    const t = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Débito', alias: 'Débito *1234', tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.bancolombiaId), ultimos_4_digitos: '7992' } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: t.id, owner_user_id: semilla.userId, ultimos_4: '7992', es_activo: true } });
    debito = t.id;
  });

  let n = 0;
  const correo = (datos: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    s.prisma.notificacionesCorreo.create({
      data: {
        owner_user_id: semilla.userId,
        external_message_id: `m-${++n}`,
        asunto: 'Alerta',
        fecha_correo: new Date('2026-10-10T15:00:00Z'),
        datos_parseados: { monto: '45000', moneda: 'COP', tipo: 'Compra', ruta: 'EGRESO', instrumento: 'CUENTA', ultimos_4: '7992', comercio: 'EXITO', ...datos } as any,
        estado_procesamiento: 'PENDIENTE',
        ...extra,
      },
    });

  it('elegir una tarjeta de débito registra el movimiento en la cuenta de la tarjeta', async () => {
    const c = await correo({});
    const r = await s.notificaciones.conciliar(Number(c.id), { accion: 'CONFIRMAR', tarjetaId: Number(debito), concepto: 'Éxito' } as any, semilla.userId);
    expect(r.compra).toBeNull();
    expect(r.transaccion).toMatchObject({ concepto: 'Éxito', estado: 'CONFIRMADO', tipo_transaccion: 'EGRESO' });
    expect(r.transaccion?.cuenta_origen_id).toBe(BigInt(semilla.bancolombiaId));
    expect(r.notificacion.estado_procesamiento).toBe('CONCILIADO');
    expect(await s.prisma.comprasCredito.count()).toBe(0);
  });

  it('una tarjeta de crédito crea la compra a 1 cuota; una tarjeta ajena no existe', async () => {
    const c = await correo({ instrumento: 'TC', ruta: 'COMPRA_TC', ultimos_4: '1111' });
    const r = await s.notificaciones.conciliar(Number(c.id), { tarjetaId: semilla.tarjetaId } as any, semilla.userId);
    expect(r.compra).toMatchObject({ numero_cuotas: 1 });
    const otra = await correo({ instrumento: 'TC', ruta: 'COMPRA_TC' });
    await expect(s.notificaciones.conciliar(Number(otra.id), { tarjetaId: 99999 } as any, semilla.userId)).rejects.toMatchObject({ status: 404 });
  });

  it('un correo en dólares sin tasa pide la TRM con un mensaje claro y con la TRM se registra', async () => {
    const cuenta = await correo({ monto: '49.99', moneda: 'USD', comercio: 'NETFLIX' });
    await expect(s.notificaciones.conciliar(Number(cuenta.id), { cuentaId: semilla.bancolombiaId } as any, semilla.userId)).rejects.toMatchObject({
      status: 400,
      response: { errors: { tasaCambio: [expect.stringContaining('TRM')] } },
    });
    const r = await s.notificaciones.conciliar(Number(cuenta.id), { cuentaId: semilla.bancolombiaId, tasaCambio: '4100.50' } as any, semilla.userId);
    expect(r.transaccion?.moneda_original).toBe('USD');
    expect(Number(r.transaccion?.monto_cop)).toBe(204984); // 49,99 × 4100,50 = 204983,995 → redondeo a centavos

    const tarjeta = await correo({ monto: '20', moneda: 'USD', instrumento: 'TC', ruta: 'COMPRA_TC', ultimos_4: '1111', comercio: 'APPLE' });
    await expect(s.notificaciones.conciliar(Number(tarjeta.id), { tarjetaId: semilla.tarjetaId } as any, semilla.userId)).rejects.toMatchObject({ status: 400, response: { errors: { tasaCambio: [expect.any(String)] } } });
    const compra = await s.notificaciones.conciliar(Number(tarjeta.id), { tarjetaId: semilla.tarjetaId, tasaCambio: 4000 } as any, semilla.userId);
    expect(compra.compra).toMatchObject({ moneda_original: 'USD', trm_confirmada: false });
    expect(Number(compra.compra?.valor_compra)).toBe(80000);
  });

  it('el cuerpo con ids vacíos o null se trata como «no enviado» (no es 400 ni crea una compra por error)', async () => {
    const dto = plainToInstance(ConciliarCorreoDto, { accion: 'CONFIRMAR', concepto: '  ', categoriaId: '', cuentaId: '2', tarjetaId: null, numeroCuotas: '', monto: null, notas: '', convertirEnPrestamo: null, responsables: null });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ accion: 'CONFIRMAR', cuentaId: 2 });
    expect(dto.tarjetaId).toBeUndefined();
    expect(dto.categoriaId).toBeUndefined();
    expect(dto.concepto).toBeUndefined();
    expect(dto.convertirEnPrestamo).toBeUndefined();

    const c = await correo({ ultimos_4: null });
    const r = await s.notificaciones.conciliar(Number(c.id), dto, semilla.userId);
    expect(r.transaccion).not.toBeNull(); // tarjetaId null NO crea una compra
    expect(r.compra).toBeNull();
  });

  it('asignar un producto con campos vacíos en «nuevo» o un id como texto es válido', async () => {
    const ok = plainToInstance(AsignarProductoDto, { ultimos4: '1111', destino: 'CUENTA', id: '2', nuevo: null });
    expect(await validate(ok)).toEqual([]);
    expect(ok.id).toBe(2);
    const nuevo = plainToInstance(AsignarProductoDto, { ultimos4: '1111', destino: 'CUENTA', nuevo: { nombre: '', tipoCuenta: '', bancoEntidad: '' } });
    expect(await validate(nuevo)).toEqual([]);
    expect(nuevo.nuevo?.tipoCuenta).toBeUndefined();
  });

  it('aceptar la sugerencia de un plástico que ya existe deja asignados sus dígitos (antes no tenía efecto)', async () => {
    const amex = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'American Express', ultimos_4_digitos: '1927' } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: amex.id, owner_user_id: semilla.userId, ultimos_4: '1927', es_activo: true } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: amex.id, owner_user_id: semilla.userId, ultimos_4: '0088', es_activo: false } }); // registrado por otra vía: falta en la lista
    await correo({ instrumento: 'TC', ruta: 'COMPRA_TC', ultimos_4: '0088' }, { ultimos_4: '0088', monto_original: '45000', moneda: 'COP' });

    const antes = (await s.productosCorreo.listar(semilla.userId)).find((p) => p.ultimos4 === '0088');
    expect(antes?.asignadoA).toBeNull();
    const r = await s.productosCorreo.asignar({ ultimos4: '0088', destino: 'TARJETA', id: Number(amex.id) } as any, semilla.userId);
    expect(r).toMatchObject({ id: Number(amex.id), creado: false });
    expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: amex.id } })).ultimos_4_digitos).toBe('1927,0088');
    const despues = (await s.productosCorreo.listar(semilla.userId)).find((p) => p.ultimos4 === '0088');
    expect(despues?.asignadoA).toMatchObject({ tipo: 'TARJETA', id: Number(amex.id) });
  });

  it('sql/008 agrega a la lista de cada tarjeta los plásticos que faltaban, sin quitar ni reordenar, y es idempotente', async () => {
    const t = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Mastercard', ultimos_4_digitos: '9491' } });
    for (const [u4, activo] of [['9491', true], ['5052', false], ['7293', false]] as const) {
      await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: t.id, owner_user_id: semilla.userId, ultimos_4: u4, es_activo: activo } });
    }
    const sinPlasticos = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Codensa', ultimos_4_digitos: null } });
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const sql = readFileSync(join(__dirname, '..', '..', 'sql', '008_cadena_ultimos4_con_todos_los_plasticos.sql'), 'utf8');
      await client.query(sql);
      const una = (await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: t.id } })).ultimos_4_digitos;
      expect(una).toBe('9491,7293,5052'); // lo que había primero; lo que faltaba al final (más reciente antes)
      await client.query(sql);
      expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: t.id } })).ultimos_4_digitos).toBe(una);
      expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: sinPlasticos.id } })).ultimos_4_digitos).toBeNull(); // sin plásticos no se toca
      expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: debito } })).ultimos_4_digitos).toBe('7992');

      // un dígito que ya identifica a OTRA tarjeta (o a una cuenta) no se duplica: quedaría ambiguo
      const otra = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Visa', ultimos_4_digitos: '1111' } });
      await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: otra.id, owner_user_id: semilla.userId, ultimos_4: '7992', es_activo: false } }); // ya es de la tarjeta de débito
      await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: otra.id, owner_user_id: semilla.userId, ultimos_4: '1234', es_activo: false } }); // ya es de la cuenta Bancolombia
      await client.query(sql);
      expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: otra.id } })).ultimos_4_digitos).toBe('1111');
    } finally {
      await client.end();
    }
  });
});
