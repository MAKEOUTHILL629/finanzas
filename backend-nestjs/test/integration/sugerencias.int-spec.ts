/* eslint-disable @typescript-eslint/no-explicit-any */
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/** Valores por defecto de los formularios y comercios habituales, deducidos del historial (plan V2, fase 4). */
describeDb('Integración BD — sugerencias de formularios', () => {
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

  const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000);
  const tarjeta = (franquicia: string, extra: Record<string, unknown> = {}) =>
    s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia, ...extra } });
  const plastico = (tarjetaId: bigint, ultimos4: string, extra: Record<string, unknown> = {}) =>
    s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: tarjetaId, owner_user_id: semilla.userId, ultimos_4: ultimos4, es_activo: true, ...extra } });
  const compra = async (concepto: string, tarjetaId: bigint | number, dias: number, extra: Record<string, unknown> = {}) =>
    s.prisma.comprasCredito.create({ data: { owner_user_id: semilla.userId, concepto, valor_compra: '1000', fecha_compra: hace(dias), numero_cuotas: 1, tarjeta: BigInt(tarjetaId), estado: 'Pendiente', ...extra } });

  it('la tarjeta de crédito es la que más se usó en los últimos 120 días (no la más usada de toda la vida)', async () => {
    const vieja = await tarjeta('Visa vieja');
    const amex = await tarjeta('American Express');
    for (let i = 0; i < 6; i++) await compra(`antigua ${i}`, vieja.id, 300 + i); // muchas, pero hace casi un año
    await compra('Reciente 1', amex.id, 3);
    await compra('Reciente 2', amex.id, 9);
    await compra('Reciente 3', vieja.id, 20);
    const d = await s.sugerencias.formularios(semilla.userId);
    expect(d.tarjetaCreditoId).toBe(Number(amex.id));
  });

  it('sin compras recientes usa la de más compras en total; sin compras, la vigente más nueva; sin nada, null', async () => {
    const vacio = await s.sugerencias.formularios(semilla.userId);
    expect(vacio.tarjetaCreditoId).toBe(semilla.tarjetaId); // la única tarjeta, aunque nunca se haya usado

    const a = await tarjeta('Mastercard');
    const b = await tarjeta('American Express');
    await plastico(a.id, '1111', { vigente_desde: new Date('2022-01-01') });
    await plastico(b.id, '1927', { vigente_desde: new Date('2024-12-27') });
    expect((await s.sugerencias.formularios(semilla.userId)).tarjetaCreditoId).toBe(Number(b.id)); // vigente más nueva

    await compra('Compra vieja', a.id, 400);
    expect((await s.sugerencias.formularios(semilla.userId)).tarjetaCreditoId).toBe(Number(a.id)); // la única con historial
  });

  it('no ofrece tarjetas de débito ni «sin número» como tarjeta de crédito', async () => {
    await s.prisma.tarjetas.deleteMany({});
    const generica = await tarjeta('Crédito sin número', { es_generica: true });
    const debito = await tarjeta('Débito', { tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.bancolombiaId) });
    await compra('x', debito.id, 1);
    expect((await s.sugerencias.formularios(semilla.userId)).tarjetaCreditoId).toBeNull();
    const real = await tarjeta('Visa');
    expect((await s.sugerencias.formularios(semilla.userId)).tarjetaCreditoId).toBe(Number(real.id));
    expect(generica.id).not.toBe(real.id);
  });

  it('la cuenta es la de más egresos recientes; sin movimientos, la principal; la débito, una vigente (de esa cuenta si hay)', async () => {
    const sinNada = await s.sugerencias.formularios(semilla.userId);
    expect(sinNada.cuentaId).toBe(semilla.bancolombiaId); // la primera usable
    await s.prisma.cuentasFinancieras.update({ where: { id: BigInt(semilla.nequiId) }, data: { es_principal: true } });
    expect((await s.sugerencias.formularios(semilla.userId)).cuentaId).toBe(semilla.nequiId);

    const mov = (cuenta: number, dias: number, extra: Record<string, unknown> = {}) =>
      s.prisma.transacciones.create({
        data: { owner_user_id: semilla.userId, tipo_transaccion: 'EGRESO', cuenta_origen_id: BigInt(cuenta), fecha_transaccion: hace(dias), concepto: 'Gasto', monto_original: '1000', monto_cop: '1000', estado: 'CONFIRMADO', ...extra },
      });
    await mov(semilla.bancolombiaId, 5);
    await mov(semilla.bancolombiaId, 8);
    await mov(semilla.nequiId, 2);
    await mov(semilla.nequiId, 400); // fuera de la ventana
    await mov(semilla.nequiId, 3, { estado: 'ANULADO' }); // anulado: no cuenta
    expect((await s.sugerencias.formularios(semilla.userId)).cuentaId).toBe(semilla.bancolombiaId);

    const dNequi = await tarjeta('Débito Nequi', { tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.nequiId) });
    const dBanco = await tarjeta('Débito Bancolombia', { tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.bancolombiaId) });
    const dViejo = await tarjeta('Débito viejo', { tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.bancolombiaId) });
    await plastico(dNequi.id, '1111', { vigente_desde: new Date('2026-01-01') });
    await plastico(dBanco.id, '7992', { vigente_desde: new Date('2025-01-01') });
    await plastico(dViejo.id, '4278', { es_activo: false, vigente_desde: new Date('2020-01-01') }); // archivado: no cuenta
    expect((await s.sugerencias.formularios(semilla.userId)).tarjetaDebitoId).toBe(Number(dBanco.id)); // de la cuenta elegida
  });

  it('las personas de los aportes van de más a menos frecuentes y se conoce al último que aportó; la última del cobro de compras', async () => {
    const obligacion = await s.prisma.obligacionesMes.create({
      data: { owner_user_id: semilla.userId, tipo_obligacion: 'CUOTA_CARRO', responsable_principal_id: BigInt(semilla.papaId), concepto: 'Carro', periodo: '2026-10', meta_mensual: '1500000', fecha_inicio: new Date('2026-10-01') },
    });
    const dia = async (n: number) => s.prisma.aportesDia.create({ data: { obligacion_mes_id: obligacion.id, fecha: new Date(`2026-10-${String(n).padStart(2, '0')}`) } });
    const aporte = async (diaId: bigint, persona: number) => s.prisma.aportesDetalle.create({ data: { aporte_dia_id: diaId, persona_id: BigInt(persona), valor: '1000', metodo: 'EFECTIVO' } });
    const d1 = await dia(1);
    const d2 = await dia(2);
    await aporte(d1.id, semilla.papaId);
    await aporte(d1.id, semilla.papaId);
    await aporte(d2.id, semilla.andresId);
    await aporte(d2.id, semilla.papaId);
    await aporte(d2.id, semilla.andresId); // el último aporte es de Andrés

    const c = await compra('Nevera', semilla.tarjetaId, 3);
    await s.prisma.responsablesComprasCredito.create({ data: { persona: BigInt(semilla.andresId), porcentaje_pago: '100', cantidad_pago: '1000', cantidad_cuotas: 1, compra_credito: c.id } });
    const c2 = await compra('Mercado', semilla.tarjetaId, 2);
    await s.prisma.responsablesComprasCredito.create({ data: { persona: BigInt(semilla.papaId), porcentaje_pago: '100', cantidad_pago: '1000', cantidad_cuotas: 1, compra_credito: c2.id } });

    const d = await s.sugerencias.formularios(semilla.userId);
    expect(d.personaAporteIds).toEqual([semilla.papaId, semilla.andresId]); // 3 vs 2 aportes
    expect(d.ultimaPersonaAporteId).toBe(semilla.andresId);
    expect(d.ultimaPersonaCompraId).toBe(semilla.papaId);
    expect(d.personaPropiaId).toBe(semilla.yoId);
    expect(d.cuotas).toBe(1);
  });

  it('un usuario nuevo recibe todo vacío, sin errores; los datos de otro usuario no se mezclan', async () => {
    const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
    const t = await s.prisma.tarjetas.create({ data: { owner_user_id: otro.id, franquicia: 'Ajena' } });
    await s.prisma.comprasCredito.create({ data: { owner_user_id: otro.id, concepto: 'Secreto', valor_compra: '1', fecha_compra: hace(1), numero_cuotas: 1, tarjeta: t.id } });
    const d = await s.sugerencias.formularios(otro.id);
    expect(d).toMatchObject({ tarjetaCreditoId: Number(t.id), tarjetaDebitoId: null, cuentaId: null, personaPropiaId: null, personaAporteIds: [], ultimaPersonaCompraId: null, ultimaPersonaAporteId: null });
    expect(await s.sugerencias.comercios(semilla.userId)).toEqual([]);
    expect((await s.sugerencias.comercios(otro.id)).map((c) => c.concepto)).toEqual(['Secreto']);
  });

  it('comercios: junta compras y egresos, resume lo habitual y filtra por texto', async () => {
    const nuevaTarjeta = await tarjeta('Visa nueva');
    await compra('DL*DIDI FOOD CO', semilla.tarjetaId, 30, { numero_cuotas: 1 });
    const c2 = await compra('Didi Food', semilla.tarjetaId, 10, { numero_cuotas: 1 });
    await compra('Didi Food', nuevaTarjeta.id, 3, { numero_cuotas: 3 });
    await s.prisma.responsablesComprasCredito.create({ data: { persona: BigInt(semilla.andresId), porcentaje_pago: '100', cantidad_pago: '1000', cantidad_cuotas: 1, compra_credito: c2.id } });
    const categoria = await s.prisma.categorias.create({ data: { owner_user_id: semilla.userId, nombre: 'Restaurantes', tipo: 'EGRESO' } });
    await s.prisma.transacciones.create({
      data: { owner_user_id: semilla.userId, tipo_transaccion: 'EGRESO', cuenta_origen_id: BigInt(semilla.nequiId), categoria_id: categoria.id, fecha_transaccion: hace(5), concepto: 'Didi Food', monto_original: '5000', monto_cop: '5000', estado: 'CONFIRMADO' },
    });
    await compra('Éxito', semilla.tarjetaId, 20);

    const todos = await s.sugerencias.comercios(semilla.userId);
    expect(todos.map((c) => [c.concepto, c.veces])).toEqual([['Didi Food', 4], ['Éxito', 1]]);
    expect(todos[0]).toMatchObject({ cuotas: 1, tarjetaId: semilla.tarjetaId, personaId: semilla.andresId, categoriaId: Number(categoria.id), cuentaId: semilla.nequiId });

    expect((await s.sugerencias.comercios(semilla.userId, { q: 'exito' })).map((c) => c.concepto)).toEqual(['Éxito']);
    expect(await s.sugerencias.comercios(semilla.userId, { limit: 1 })).toHaveLength(1);
  });
});
