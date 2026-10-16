/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { NotificacionItemDto } from '../../src/modules/notificaciones-correo/dto/sync-batch.dto';
import { TEST_DATABASE_URL, crearServicios, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Plásticos de una tarjeta contra PostgreSQL real: reemplazo (renovación/reposición) sin perder el historial, plástico de cada compra
 * (guardado o deducido por fecha), historial unificado y relleno de `sql/004` a partir de los avisos del banco.
 */
describeDb('Integración BD — plásticos de tarjeta', () => {
  let s: Servicios;
  let semilla: Semilla;
  let tarjeta: number;

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
    tarjeta = semilla.tarjetaId;
    await s.prisma.tarjetas.update({ where: { id: BigInt(tarjeta) }, data: { franquicia: 'American Express', descripcion: null } });
  });

  const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const registrar = (ultimos4: string, extra: Record<string, unknown> = {}) =>
    s.plasticos.reemplazar(tarjeta, { ultimos4, ...extra } as any, semilla.userId);
  const compra = (concepto: string, fecha: string, extra: Record<string, unknown> = {}, tarjetaId = tarjeta) =>
    s.compras.save({ concepto, valorCompra: 100000, fechaCompra: fecha, numeroCuotas: 2, interes: 0, descripcion: 'x', estado: 'Pendiente', tarjeta: tarjetaId, ...extra } as any, semilla.userId);
  const plasticos = () => s.prisma.tarjetaPlasticos.findMany({ where: { tarjeta_id: BigInt(tarjeta) }, orderBy: { id: 'asc' } });
  const cadena = async () => (await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: BigInt(tarjeta) } })).ultimos_4_digitos;

  async function ejecutarSql004(): Promise<void> {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(readFileSync(join(__dirname, '..', '..', 'sql', '004_plasticos_tarjeta.sql'), 'utf8'));
    } finally {
      await client.end();
    }
  }

  it('registrar un reemplazo archiva el plástico anterior y NO toca las compras, las cuotas ni sus responsables', async () => {
    await registrar('1927', { vigenteDesde: '2024-12-27' });
    const antes = await compra('Nevera', '2025-02-10');
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 50000, cantidadCuotas: 2, compraCredito: antes } as any, semilla.userId);
    const conteo = async () => ({
      compras: await s.prisma.comprasCredito.count(),
      cuotas: await s.prisma.cuotasDetalle.count(),
      responsables: await s.prisma.responsablesComprasCredito.count(),
      movimientos: await s.prisma.movimientosDeudaPersona.count(),
    });
    const previo = await conteo();

    const r = await registrar('9587', { vigenteDesde: '2026-10-01', motivo: 'PERDIDA', notas: 'Reposición por pérdida' });

    expect(r.plasticoActivo).toMatchObject({ ultimos4: '9587', esActivo: true, vigenteDesde: '2026-10-01', motivoReemplazo: 'PERDIDA', notas: 'Reposición por pérdida' });
    expect(r.plasticoAnterior).toMatchObject({ ultimos4: '1927', esActivo: false, vigenteHasta: '2026-09-30' });
    expect(r.plasticoActivo.reemplazaAId).toBe(r.plasticoAnterior?.id);
    expect(await conteo()).toEqual(previo);
    expect(await cadena()).toBe('9587,1927'); // el parser de correos sigue reconociendo los dos
    expect((await plasticos()).filter((p) => p.es_activo)).toHaveLength(1);
    // la compra anterior sigue colgando de la MISMA línea de crédito
    expect((await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(antes) } })).tarjeta).toBe(BigInt(tarjeta));
  });

  it('rechaza dígitos repetidos, de otro producto o un inicio anterior al plástico actual; y permite reactivar uno archivado', async () => {
    await registrar('1927', { vigenteDesde: '2024-12-27' });
    await registrar('9587', { vigenteDesde: '2026-10-01' });

    await expect(registrar('9587')).rejects.toMatchObject({ status: 409 }); // ya es el activo
    await expect(registrar('1234')).rejects.toMatchObject({ status: 409 }); // dígitos de la cuenta Bancolombia
    await expect(registrar('5555', { vigenteDesde: '2026-09-01' })).rejects.toMatchObject({ status: 400 }); // empieza antes del activo (2026-10-01)
    await expect(s.plasticos.reemplazar(tarjeta + 99, { ultimos4: '5555' } as any, semilla.userId)).rejects.toMatchObject({ status: 404 });

    // aparece el plástico viejo: se reactiva (no se duplica) y el activo pasa a archivado
    const r = await registrar('1927', { vigenteDesde: '2026-10-10' });
    expect(r.plasticos).toHaveLength(2);
    expect(r.plasticos.find((p) => p.esActivo)).toMatchObject({ ultimos4: '1927', vigenteHasta: null });
    expect(r.plasticos.find((p) => !p.esActivo)).toMatchObject({ ultimos4: '9587', vigenteHasta: '2026-10-09' });
  });

  it('una compra nueva guarda el plástico vigente en su fecha; el usuario puede elegir uno archivado (retroactivo) pero no de otra tarjeta', async () => {
    await registrar('9587', { vigenteDesde: '2020-01-01' });
    await registrar('1927', { vigenteDesde: '2025-01-01' });
    const [viejo, nuevo] = [(await plasticos()).find((p) => p.ultimos_4 === '9587'), (await plasticos()).find((p) => p.ultimos_4 === '1927')];

    const actual = await compra('Hoy', '2026-10-01');
    const retro = await compra('Retroactiva', '2023-05-05');
    const elegida = await compra('Elegida', '2026-10-02', { plasticoId: Number(viejo?.id) });
    const plasticoDe = async (id: number) => (await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(id) } })).plastico_id;
    expect(await plasticoDe(actual)).toBe(nuevo?.id);
    expect(await plasticoDe(retro)).toBe(viejo?.id); // la fecha es anterior al plástico activo → el que regía entonces
    expect(await plasticoDe(elegida)).toBe(viejo?.id);

    const otra = await s.prisma.tarjetas.create({ data: { franquicia: 'Visa', owner_user_id: semilla.userId } });
    const ajeno = await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: otra.id, owner_user_id: semilla.userId, ultimos_4: '7777' } });
    await expect(compra('Mala', '2026-10-03', { plasticoId: Number(ajeno.id) })).rejects.toMatchObject({ status: 400 });
    expect((await s.compras.list(semilla.userId)).find((c) => c.id === elegida)).toMatchObject({ plasticoId: Number(viejo?.id), plasticoUltimos4: '9587' });
  });

  it('el historial unifica las compras de TODOS los plásticos, marca el plástico de cada una y filtra por plástico', async () => {
    await registrar('9587', { vigenteDesde: '2020-01-01' });
    await registrar('1927', { vigenteDesde: '2025-01-01' });
    const viejo = (await plasticos()).find((p) => p.ultimos_4 === '9587');
    const nuevo = (await plasticos()).find((p) => p.ultimos_4 === '1927');
    // Compras SIN plástico guardado (como las anteriores a sql/004): el plástico se deduce por fecha.
    const futura = `${mesRelativo(3)}-10`; // sus cuotas aún no vencen: son las únicas «pendientes»
    const a = await compra('Antigua', '2024-01-10');
    const b = await compra('Reciente', futura);
    await s.prisma.comprasCredito.updateMany({ where: { id: { in: [BigInt(a), BigInt(b)] } }, data: { plastico_id: null } });
    const c = await compra('Marcada', '2026-04-01', { plasticoId: Number(viejo?.id) });
    // una compra de otra tarjeta no entra en este historial
    const otra = await s.prisma.tarjetas.create({ data: { franquicia: 'Visa', owner_user_id: semilla.userId } });
    await compra('Ajena', '2026-01-01', {}, Number(otra.id));

    const h = await s.plasticos.historial(tarjeta, {}, semilla.userId);
    expect(h.totales.compras).toBe(3);
    expect(h.totales.valorCompras.toString()).toBe('300000');
    expect(h.totales.saldoPendiente.toString()).toBe('100000'); // solo las 2 cuotas de la compra futura siguen pendientes
    expect(h.compras.find((x) => x.id === b)).toMatchObject({ cuotasPendientes: 2, saldoPendiente: expect.anything(), proximaCuota: expect.any(String) });
    const por = (id: number) => h.compras.find((x) => x.id === id) as any;
    expect(por(a)).toMatchObject({ plastico: { ultimos4: '9587' }, plasticoInferido: true });
    expect(por(b)).toMatchObject({ plastico: { ultimos4: '1927' }, plasticoInferido: true });
    expect(por(c)).toMatchObject({ plastico: { ultimos4: '9587' }, plasticoInferido: false });
    expect(h.porPlastico.find((x) => x.ultimos4 === '9587')).toMatchObject({ compras: 2, inferidas: 1 });

    const soloViejo = await s.plasticos.historial(tarjeta, { plasticoId: Number(viejo?.id) }, semilla.userId);
    expect(soloViejo.compras.map((x) => x.id).sort()).toEqual([a, c].sort());
    expect(soloViejo.totales.compras).toBe(2);
    const rango = await s.plasticos.historial(tarjeta, { desde: '2024-01-01', hasta: '2024-12-31' }, semilla.userId);
    expect(rango.compras.map((x) => x.id)).toEqual([a]);
    expect(Number(nuevo?.id)).toBeGreaterThan(0);
    await expect(s.plasticos.historial(tarjeta + 99, {}, semilla.userId)).rejects.toMatchObject({ status: 404 });
  });

  it('un aviso del banco crea la compra con el plástico de sus 4 dígitos y completa el de una compra que ya existía', async () => {
    const manual = await compra('DIDI FOODS', '2026-10-13', { valorCompra: 50000, numeroCuotas: 1 });
    await s.prisma.comprasCredito.update({ where: { id: BigInt(manual) }, data: { plastico_id: null } }); // anterior a sql/004
    await s.productosCorreo.asignar({ ultimos4: '1927', destino: 'TARJETA', id: tarjeta }, semilla.userId);
    const p = (await plasticos()).find((x) => x.ultimos_4 === '1927');
    const item = (extra: Partial<NotificacionItemDto>): NotificacionItemDto =>
      ({ externalMessageId: '<m1>', fecha: '2026-10-13', hora: '14:02:11', tipo: 'Compra', metodo: 'Tarjeta Credito', comercio: 'DL*DIDI FOOD CO', origenRaw: 'T.Cred *1927', valor: '50.000', moneda: 'COP', ...extra }) as NotificacionItemDto;

    const enlazada = await s.syncBatch.syncBatch([item({})], semilla.userId);
    expect(enlazada.detalle[0]).toMatchObject({ vinculo: 'EXISTENTE', compraCreditoId: manual });
    expect((await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(manual) } })).plastico_id).toBe(p?.id);

    const nueva = await s.syncBatch.syncBatch([item({ externalMessageId: '<m2>', comercio: 'TIENDA NUEVA', fecha: '2026-10-14', valor: '12.345' })], semilla.userId);
    const creadaId = (nueva.detalle[0] as any).compraCreditoId as number;
    expect((await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(creadaId) } })).plastico_id).toBe(p?.id);
  });

  it('asignar dígitos MÁS RECIENTES que los del plástico activo (según los avisos) cambia el activo; unos más antiguos entran archivados', async () => {
    const aviso = (id: string, u4: string, fecha: string) =>
      s.prisma.notificacionesCorreo.create({ data: { owner_user_id: semilla.userId, external_message_id: id, fecha_correo: new Date(`${fecha}T15:00:00Z`), estado_procesamiento: 'PENDIENTE', ultimos_4: u4 } });
    await aviso('<a1>', '9587', '2022-01-04');
    await aviso('<a2>', '9587', '2024-03-16');
    await aviso('<b1>', '1927', '2024-12-27');
    await aviso('<b2>', '1927', '2026-10-15');
    await aviso('<c1>', '0088', '2024-03-20');
    await aviso('<c2>', '0088', '2024-06-04');

    await s.productosCorreo.asignar({ ultimos4: '9587', destino: 'TARJETA', id: tarjeta }, semilla.userId); // primero (único): activo
    await s.productosCorreo.asignar({ ultimos4: '1927', destino: 'TARJETA', id: tarjeta }, semilla.userId); // más reciente: pasa a activo
    await s.productosCorreo.asignar({ ultimos4: '0088', destino: 'TARJETA', id: tarjeta }, semilla.userId); // intermedio: archivado

    const lista = await plasticos();
    const por = (u4: string) => lista.find((p) => p.ultimos_4 === u4) as any;
    expect(por('1927')).toMatchObject({ es_activo: true });
    expect(por('1927').vigente_desde.toISOString().slice(0, 10)).toBe('2024-12-27');
    expect(por('9587')).toMatchObject({ es_activo: false });
    expect(por('9587').vigente_hasta.toISOString().slice(0, 10)).toBe('2024-03-16');
    expect(por('0088')).toMatchObject({ es_activo: false });
    expect(por('0088').vigente_hasta.toISOString().slice(0, 10)).toBe('2024-06-04');
    expect(await cadena()).toBe('1927,0088,9587');
  });

  it('la edición clásica de ultimos4Digitos mantiene los plásticos: agrega, quita solo los que no tienen compras y valida los dígitos ajenos', async () => {
    await s.tarjetas.actualizar(tarjeta, { ultimos4Digitos: '1927,9587' }, semilla.userId);
    expect((await plasticos()).map((p) => p.ultimos_4).sort()).toEqual(['1927', '9587']);
    expect((await plasticos()).filter((p) => p.es_activo)).toHaveLength(1);

    await expect(s.tarjetas.actualizar(tarjeta, { ultimos4Digitos: '1927,1234' }, semilla.userId)).rejects.toMatchObject({ status: 409 }); // 1234 es de la cuenta
    expect((await plasticos()).map((p) => p.ultimos_4).sort()).toEqual(['1927', '9587']); // la transacción se revirtió

    const conCompra = (await plasticos()).find((p) => p.ultimos_4 === '9587');
    await compra('Con plástico', '2026-01-01', { plasticoId: Number(conCompra?.id) });
    const r: any = await s.tarjetas.actualizar(tarjeta, { ultimos4Digitos: '1927' }, semilla.userId);
    expect(r.plasticos.map((p: any) => p.ultimos4).sort()).toEqual(['1927', '9587']); // el 9587 tiene una compra: se conserva
    expect(r.ultimos4Activo).toBeTruthy();

    const lista: any[] = await s.tarjetas.list(semilla.userId);
    expect(lista.find((t) => t.id === tarjeta)).toMatchObject({ plasticoActivo: expect.objectContaining({ esActivo: true }), plasticos: expect.any(Array) });
  });

  it('eliminar: no un plástico con compras ni el activo mientras haya otros; sí uno archivado sin compras', async () => {
    await registrar('1927');
    await registrar('9587');
    const [viejo, activo] = [(await plasticos()).find((p) => p.ultimos_4 === '1927'), (await plasticos()).find((p) => p.ultimos_4 === '9587')];
    await compra('Compra con el viejo', '2026-02-02', { plasticoId: Number(viejo?.id) });

    await expect(s.plasticos.eliminar(tarjeta, Number(viejo?.id), semilla.userId)).rejects.toMatchObject({ status: 409 }); // tiene una compra
    await expect(s.plasticos.eliminar(tarjeta, Number(activo?.id), semilla.userId)).rejects.toMatchObject({ status: 409 }); // es el activo

    await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: BigInt(tarjeta), owner_user_id: semilla.userId, ultimos_4: '0088', es_activo: false } });
    const sobrante = (await plasticos()).find((p) => p.ultimos_4 === '0088');
    const restantes = await s.plasticos.eliminar(tarjeta, Number(sobrante?.id), semilla.userId);
    expect(restantes.map((p) => p.ultimos4).sort()).toEqual(['1927', '9587']);
    expect(await cadena()).toBe('9587,1927');
    await expect(s.plasticos.eliminar(tarjeta, 999999, semilla.userId)).rejects.toMatchObject({ status: 404 });
  });

  it('sql/004: crea un plástico por cada grupo de dígitos con fechas deducidas de los avisos, completa compras y es idempotente', async () => {
    const mc = await s.prisma.tarjetas.create({ data: { franquicia: 'Mastercard', owner_user_id: semilla.userId, ultimos_4_digitos: '9491' } });
    await s.prisma.tarjetas.update({ where: { id: BigInt(tarjeta) }, data: { ultimos_4_digitos: '1927,9587' } });
    const aviso = (id: string, u4: string, fecha: string, extra: Record<string, unknown> = {}) =>
      s.prisma.notificacionesCorreo.create({ data: { owner_user_id: semilla.userId, external_message_id: id, fecha_correo: new Date(`${fecha}T15:00:00Z`), estado_procesamiento: 'PENDIENTE', ultimos_4: u4, ...extra } });
    await aviso('<v1>', '9587', '2022-01-04');
    await aviso('<v2>', '9587', '2024-03-16');
    const c = await compra('Ya conciliada', '2026-05-05');
    await s.prisma.comprasCredito.update({ where: { id: BigInt(c) }, data: { plastico_id: null } });
    await aviso('<n1>', '1927', '2024-12-27');
    await aviso('<n2>', '1927', '2026-10-15', { compra_credito_generada_id: BigInt(c) });
    await s.prisma.tarjetaPlasticos.deleteMany({}); // estado previo a sql/004: sin plásticos

    await ejecutarSql004();

    const amex = await plasticos();
    const por = (u4: string) => amex.find((p) => p.ultimos_4 === u4) as any;
    expect(amex).toHaveLength(2);
    expect(por('1927')).toMatchObject({ es_activo: true, vigente_hasta: null, reemplaza_a_id: por('9587').id });
    expect(por('1927').vigente_desde.toISOString().slice(0, 10)).toBe('2024-12-27');
    expect(por('9587')).toMatchObject({ es_activo: false, vigente_desde: null, reemplaza_a_id: null });
    expect(por('9587').vigente_hasta.toISOString().slice(0, 10)).toBe('2024-03-16');
    const unico = await s.prisma.tarjetaPlasticos.findFirstOrThrow({ where: { tarjeta_id: mc.id } });
    expect(unico).toMatchObject({ ultimos_4: '9491', es_activo: true, vigente_desde: null, vigente_hasta: null }); // sin otros plásticos: no se inventan fechas
    // la compra que nació de un aviso con 1927 queda con ese plástico
    expect((await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(c) } })).plastico_id).toBe(por('1927').id);

    const total = await s.prisma.tarjetaPlasticos.count();
    await ejecutarSql004();
    expect(await s.prisma.tarjetaPlasticos.count()).toBe(total); // idempotente
  });
});
