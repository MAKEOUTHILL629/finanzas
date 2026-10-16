/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_URL, crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Tarjetas de crédito/débito, vínculo con cuentas y semilla de los 13 productos financieros (sql/006 y sql/007) contra PostgreSQL real.
 */
describeDb('Integración BD — productos financieros (tarjetas de débito, cuentas y línea de tiempo)', () => {
  let s: Servicios;
  let semilla: Semilla;
  let principal: bigint;
  let padre: bigint;

  beforeAll(async () => {
    await prepararEsquema();
    s = await crearServicios();
  });
  afterAll(async () => {
    await s.prisma.$disconnect();
  });

  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  /** La base como está hoy en producción: dos cuentas, la línea Mastercard y la American Express con sus plásticos. */
  beforeEach(async () => {
    await vaciarTablas();
    semilla = await sembrar(s.prisma);
    await s.prisma.cuentasFinancieras.deleteMany();
    await s.prisma.tarjetas.deleteMany();
    const owner = semilla.userId;
    principal = (await s.prisma.cuentasFinancieras.create({ data: { owner_user_id: owner, nombre: 'Bancolombia Principal', tipo_cuenta: 'AHORROS', ultimos_4_digitos: '3698', es_principal: true } })).id;
    padre = (await s.prisma.cuentasFinancieras.create({ data: { owner_user_id: owner, nombre: 'Bancolombia Padre', tipo_cuenta: 'AHORROS', ultimos_4_digitos: '4248' } })).id;
    const mc = await s.prisma.tarjetas.create({ data: { owner_user_id: owner, franquicia: 'Mastercard', ultimos_4_digitos: '9491' } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: mc.id, owner_user_id: owner, ultimos_4: '9491', es_activo: true } });
    const amex = await s.prisma.tarjetas.create({ data: { owner_user_id: owner, franquicia: 'American Express', ultimos_4_digitos: '1927,9587' } });
    const viejo = await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: amex.id, owner_user_id: owner, ultimos_4: '9587', es_activo: false, vigente_hasta: d('2024-03-16') } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: amex.id, owner_user_id: owner, ultimos_4: '1927', es_activo: true, vigente_desde: d('2024-12-27'), reemplaza_a_id: viejo.id } });
    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: amex.id, owner_user_id: owner, ultimos_4: '0088', es_activo: false, vigente_desde: d('2024-03-20'), vigente_hasta: d('2024-06-04') } });
  });

  async function sembrar007(): Promise<void> {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(readFileSync(join(__dirname, '..', '..', 'sql', '007_semilla_productos_financieros.sql'), 'utf8'));
    } finally {
      await client.end();
    }
  }

  const estadoBd = async () => ({
    tarjetas: await s.prisma.tarjetas.findMany({ orderBy: { id: 'asc' } }),
    plasticos: await s.prisma.tarjetaPlasticos.findMany({ orderBy: { id: 'asc' } }),
    cuentas: await s.prisma.cuentasFinancieras.findMany({ orderBy: { id: 'asc' } }),
  });
  const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));

  it('la semilla deja los 13 productos: 9 tarjetas (6 crédito, 3 débito) y las 3 cuentas, sin duplicar lo que ya existía', async () => {
    await sembrar007();

    const plasticos = await s.prisma.tarjetaPlasticos.findMany({ include: { tarjeta: true }, orderBy: { id: 'asc' } });
    expect(plasticos.map((p) => p.ultimos_4).sort()).toEqual(['0088', '1927', '4278', '5052', '7293', '7992', '8949', '9491', '9587']);
    const tipo = (u4: string) => plasticos.find((p) => p.ultimos_4 === u4)?.tarjeta.tipo_tarjeta;
    expect(['1927', '9587', '0088', '9491', '7293', '5052'].map(tipo)).toEqual(Array(6).fill('CREDITO'));
    expect(['7992', '8949', '4278'].map(tipo)).toEqual(Array(3).fill('DEBITO'));

    // 7293 y 5052 cuelgan de la línea Mastercard (9491); 9587/0088/1927 siguen en la American Express
    const linea = (u4: string) => plasticos.find((p) => p.ultimos_4 === u4)?.tarjeta_id;
    expect(linea('7293')).toBe(linea('9491'));
    expect(linea('5052')).toBe(linea('9491'));
    expect(linea('0088')).toBe(linea('1927'));
    // las tres de débito son una cadena en la cuenta principal *3698
    const debito = plasticos.find((p) => p.ultimos_4 === '7992')?.tarjeta;
    expect(debito?.cuenta_id).toBe(principal);
    expect([linea('4278'), linea('8949')]).toEqual([linea('7992'), linea('7992')]);
    expect(debito?.alias).toBe('Débito *3698');
    expect(debito?.ultimos_4_digitos).toBe('7992,8949,4278'); // activo primero, luego del más reciente al más antiguo

    // Las cuentas existentes no se duplican; solo se agrega la «sin número» (histórica)
    const cuentas = await s.prisma.cuentasFinancieras.findMany({ orderBy: { id: 'asc' } });
    expect(cuentas.length).toBe(3);
    expect(cuentas.filter((c) => c.ultimos_4_digitos === '3698').length).toBe(1);
    expect(cuentas.filter((c) => c.ultimos_4_digitos === '4248').length).toBe(1);
    expect(cuentas.find((c) => c.es_generica)).toMatchObject({ is_active: false, fecha_inicio_uso: d('2021-08-27'), fecha_fin_uso: d('2026-07-22') });
    expect(cuentas.find((c) => c.id === principal)?.fecha_inicio_uso).toEqual(d('2021-08-09'));
    expect(cuentas.find((c) => c.id === padre)?.fecha_inicio_uso).toEqual(d('2026-09-17'));

    // La tarjeta de crédito «sin número»
    expect(await s.prisma.tarjetas.count({ where: { es_generica: true, tipo_tarjeta: 'CREDITO' } })).toBe(1);
  });

  it('respeta lo que ya había: solo rellena vigencias vacías y no cambia plásticos, enlaces ni dígitos existentes', async () => {
    const antes = await estadoBd();
    await sembrar007();
    const despues = await estadoBd();

    const ps = (e: typeof antes, u4: string) => e.plasticos.find((p) => p.ultimos_4 === u4)!;
    expect(ps(despues, '1927')).toMatchObject({ es_activo: true, reemplaza_a_id: ps(antes, '1927').reemplaza_a_id, vigente_desde: d('2024-12-27') });
    expect(ps(despues, '9587').vigente_desde).toEqual(d('2022-01-04')); // estaba vacío: se rellenó
    expect(ps(despues, '9587').vigente_hasta).toEqual(d('2024-03-16')); // ya tenía: no se tocó
    expect(ps(despues, '9491')).toMatchObject({ es_activo: true, vigente_desde: d('2024-12-28'), vigente_hasta: null });
    // La lista de dígitos de la línea American Express no se modificó; la de Mastercard ganó sus plásticos históricos
    expect(despues.tarjetas.find((t) => t.franquicia === 'American Express')?.ultimos_4_digitos).toBe('1927,9587');
    expect(despues.tarjetas.find((t) => t.franquicia === 'Mastercard')?.ultimos_4_digitos).toBe('9491,5052,7293');
    // Las dos cuentas existentes conservan nombre, dígitos y saldo
    for (const id of [principal, padre]) {
      const a = antes.cuentas.find((c) => c.id === id)!;
      const b = despues.cuentas.find((c) => c.id === id)!;
      expect({ nombre: b.nombre, u4: b.ultimos_4_digitos, saldo: String(b.saldo_actual), activa: b.is_active }).toEqual({ nombre: a.nombre, u4: a.ultimos_4_digitos, saldo: String(a.saldo_actual), activa: a.is_active });
    }
  });

  it('si las secuencias de id quedaron atrás (filas con id explícito) las adelanta y no choca', async () => {
    for (const tabla of ['TarjetaPlasticos', 'Tarjetas', 'CuentasFinancieras']) {
      await s.prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${tabla}"', 'id'), 1, false)`);
    }
    await sembrar007();
    expect(await s.prisma.tarjetaPlasticos.count()).toBe(9);
    // y la secuencia sigue siendo utilizable después
    const nueva = await s.tarjetas.crear({ tipo: 'CREDITO', ultimos4: '1212', franquicia: 'Visa' }, semilla.userId);
    expect(nueva.id).toBeGreaterThan(0);
  });

  it('es idempotente: volver a ejecutarla no cambia ni una fila', async () => {
    await sembrar007();
    const primera = json(await estadoBd());
    await sembrar007();
    await sembrar007();
    expect(json(await estadoBd())).toBe(primera);
  });

  it('en una base sin datos de usuario no hace nada', async () => {
    await vaciarTablas();
    await sembrar007();
    expect(await s.prisma.tarjetas.count()).toBe(0);
    expect(await s.prisma.cuentasFinancieras.count()).toBe(0);
  });

  it('la línea de tiempo lista los 13 productos con su tipo y estado', async () => {
    await sembrar007();
    const t = await s.productos.lineaTiempo(semilla.userId, new Date('2026-10-16T15:00:00Z'));
    expect(t.productos.length).toBe(13);
    expect(t.hasta).toBe('2026-10-16');
    expect(t.desde).toBe('2021-08-09');
    const por = Object.fromEntries(t.productos.map((p) => [p.etiqueta, p]));
    expect(por['Crédito *1927']).toMatchObject({ estado: 'ACTIVA', hasta: null, desde: '2024-12-27' });
    expect(por['Crédito *9587']).toMatchObject({ estado: 'REEMPLAZADA', desde: '2022-01-04', hasta: '2024-03-16' });
    expect(por['Crédito *7293']).toMatchObject({ estado: 'REEMPLAZADA', desde: '2022-08-25', hasta: '2024-03-16' });
    expect(por['Débito *4278']).toMatchObject({ tipo: 'DEBITO', estado: 'REEMPLAZADA', desde: '2021-11-26' });
    expect(por['Débito *7992']).toMatchObject({ tipo: 'DEBITO', estado: 'ACTIVA', hasta: null });
    expect(por['Cuenta *3698']).toMatchObject({ tipo: 'CUENTA', estado: 'ACTIVA' });
    expect(por['Cuenta (sin número)']).toMatchObject({ generica: true, estado: 'INACTIVA', hasta: '2026-07-22' });
    expect(por['Crédito (sin número)']).toMatchObject({ generica: true, tipo: 'CREDITO' });
    expect(t.productos.filter((p) => p.tipo === 'CREDITO').length).toBe(7);
    expect(t.productos.filter((p) => p.tipo === 'DEBITO').length).toBe(3);
    expect(t.productos.filter((p) => p.tipo === 'CUENTA').length).toBe(3);
  });

  it('la línea de tiempo cuenta compras (guardadas o deducidas por fecha), avisos del banco y transacciones', async () => {
    await sembrar007();
    const amex = (await s.prisma.tarjetaPlasticos.findFirstOrThrow({ where: { ultimos_4: '1927' } })).tarjeta_id;
    const compra = (concepto: string, fecha: string, valor: number) =>
      s.compras.save({ concepto, valorCompra: valor, fechaCompra: fecha, numeroCuotas: 1, interes: 0, descripcion: 'x', estado: 'Pendiente', tarjeta: Number(amex) } as any, semilla.userId);
    await compra('Antigua', '2023-05-01', 100000); // la deduce el plástico 9587 (hasta 2024-03-16)
    await compra('Intermedia', '2024-04-10', 50000); // 0088
    await compra('Reciente', '2025-02-01', 25000); // 1927
    await compra('Reciente 2', '2026-01-01', 25000);
    await s.prisma.notificacionesCorreo.create({
      data: { owner_user_id: semilla.userId, external_message_id: 'm-1', fecha_correo: new Date('2026-09-20T15:00:00Z'), ultimos_4: '7992', monto_original: '45000', moneda: 'COP', datos_parseados: { instrumento: 'CUENTA' }, estado_procesamiento: 'PENDIENTE' },
    });
    await s.transacciones.create({ tipoTransaccion: 'EGRESO', cuentaOrigenId: Number(principal), concepto: 'Mercado', montoOriginal: '30000', fechaTransaccion: '2026-10-02T15:00:00Z', estado: 'CONFIRMADO' } as any, semilla.userId);

    const t = await s.productos.lineaTiempo(semilla.userId, new Date('2026-10-16T15:00:00Z'));
    const por = Object.fromEntries(t.productos.map((p) => [p.etiqueta, p]));
    expect(por['Crédito *9587']).toMatchObject({ compras: 1, movimientos: 1, monto: 100000, fuente: 'REGISTROS' });
    expect(por['Crédito *0088']).toMatchObject({ compras: 1, monto: 50000 });
    expect(por['Crédito *1927']).toMatchObject({ compras: 2, monto: 50000 });
    expect(por['Débito *7992']).toMatchObject({ avisos: 1, movimientos: 1, monto: 45000, fuente: 'AVISOS' });
    expect(por['Cuenta *3698']).toMatchObject({ transacciones: 1, movimientos: 1, monto: 30000, fuente: 'REGISTROS' });
  });

  it('los avisos con los dígitos de la tarjeta de débito se reconocen como movimientos de su cuenta', async () => {
    await sembrar007();
    const snap = await s.ejecutorCorreos.cargarSnapshot(semilla.userId);
    const cuenta = snap.cuentas.find((c) => c.id === principal)!;
    expect(cuenta.ultimos_4_digitos?.split(',').sort()).toEqual(['3698', '4278', '7992', '8949']);
    // y la columna real de la cuenta no se tocó
    expect((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: principal } })).ultimos_4_digitos).toBe('3698');
    // las tarjetas del snapshot son solo de crédito
    expect(snap.tarjetas.every((t) => !String(t.ultimos_4_digitos ?? '').includes('7992'))).toBe(true);
  });

  it('una tarjeta de débito sin cuenta no existe (restricción de la BD) y una cuenta con tarjetas no se borra', async () => {
    await expect(s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Débito', tipo_tarjeta: 'DEBITO' } })).rejects.toThrow();
    await expect(s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'X', tipo_tarjeta: 'PREPAGO' } })).rejects.toThrow();
    await sembrar007();
    await expect(s.cuentas.remove(Number(principal), semilla.userId)).rejects.toMatchObject({ status: 409 });
    await expect(s.prisma.cuentasFinancieras.delete({ where: { id: principal } })).rejects.toThrow();
  });

  it('POST de tarjetas: se pueden crear varias de la misma cuenta y franquicia; las compras a crédito rechazan el débito', async () => {
    const a = await s.tarjetas.crear({ tipo: 'DEBITO', cuentaId: Number(padre), ultimos4: '1111', alias: 'Débito de papá' }, semilla.userId);
    const b = await s.tarjetas.crear({ tipo: 'DEBITO', cuentaId: Number(padre), ultimos4: '2222', estado: 'INACTIVA', fechaInicioUso: '2024-01-01', fechaFinUso: '2025-01-01' }, semilla.userId);
    expect(a).toMatchObject({ tipo: 'DEBITO', cuentaId: Number(padre), ultimos4Activo: '1111' });
    expect(b.plasticos[0]).toMatchObject({ ultimos4: '2222', esActivo: false, estado: 'INACTIVA', fechaInicioUso: '2024-01-01', fechaFinUso: '2025-01-01' });
    await expect(s.tarjetas.crear({ tipo: 'DEBITO', cuentaId: Number(padre), ultimos4: '1111' }, semilla.userId)).rejects.toMatchObject({ status: 409 });

    await expect(
      s.compras.save({ concepto: 'x', valorCompra: 1000, fechaCompra: '2026-10-01', numeroCuotas: 1, interes: 0, descripcion: 'x', estado: 'Pendiente', tarjeta: a.id } as any, semilla.userId),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('renovar un plástico: el anterior queda REEMPLAZADO y el historial de compras no se pierde', async () => {
    const credito = await s.tarjetas.crear({ tipo: 'CREDITO', ultimos4: '3333', franquicia: 'Visa', fechaInicioUso: '2025-01-01' }, semilla.userId);
    const compra = await s.compras.save({ concepto: 'Nevera', valorCompra: 100000, fechaCompra: '2025-06-01', numeroCuotas: 2, interes: 0, descripcion: 'x', estado: 'Pendiente', tarjeta: credito.id } as any, semilla.userId);
    const renovada = await s.tarjetas.crear({ tipo: 'CREDITO', ultimos4: '4444', plasticoAnteriorId: credito.plasticoActivo!.id, fechaInicioUso: '2026-06-01', motivo: 'VENCIMIENTO' }, semilla.userId);
    expect(renovada.id).toBe(credito.id); // misma línea, no una tarjeta nueva
    expect(renovada.plasticos.map((p) => [p.ultimos4, p.estado])).toEqual([['4444', 'ACTIVA'], ['3333', 'REEMPLAZADA']]);
    expect(renovada.plasticos.find((p) => p.ultimos4 === '3333')).toMatchObject({ fechaFinUso: '2026-05-31', fechaInicioUso: '2025-01-01' });
    expect(renovada.plasticos.find((p) => p.ultimos4 === '4444')).toMatchObject({ tarjetaReemplazadaId: credito.plasticoActivo!.id });
    expect(await s.prisma.comprasCredito.count({ where: { id: BigInt(compra), tarjeta: BigInt(credito.id) } })).toBe(1);
  });

  it('agregar un plástico histórico no cambia el activo', async () => {
    const t = await s.tarjetas.crear({ tipo: 'CREDITO', ultimos4: '5555', franquicia: 'Visa' }, semilla.userId);
    const lista = await s.plasticos.agregarHistorico(t.id, { ultimos4: '6666', vigenteDesde: '2020-01-01', vigenteHasta: '2021-01-01', motivo: 'PERDIDA' }, semilla.userId);
    expect(lista.find((p) => p.ultimos4 === '5555')?.estado).toBe('ACTIVA');
    expect(lista.find((p) => p.ultimos4 === '6666')).toMatchObject({ estado: 'REEMPLAZADA', esActivo: false, motivoReemplazo: 'PERDIDA' }); // la línea siguió con el 5555
    await expect(s.plasticos.agregarHistorico(t.id, { ultimos4: '6666' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
  });

  it('GET lookup de tarjetas trae tipo, cuenta y estado de cada plástico', async () => {
    await sembrar007();
    const lookup = new (await import('../../src/modules/lookup/lookup.service')).LookupService(s.prisma);
    const tarjetas = await lookup.tarjetas(semilla.userId);
    const debito = tarjetas.find((t) => t.tipo === 'DEBITO')!;
    expect(debito).toMatchObject({ cuentaId: Number(principal), alias: 'Débito *3698', ultimos4Activo: '7992', etiqueta: 'Débito ··7992' });
    expect(debito.plasticos.map((p) => [p.ultimos4, p.estado])).toEqual([['7992', 'ACTIVA'], ['8949', 'REEMPLAZADA'], ['4278', 'REEMPLAZADA']]);
    expect(tarjetas.find((t) => t.esGenerica)).toMatchObject({ tipo: 'CREDITO', etiqueta: 'Crédito (sin número)' });
  });
});
