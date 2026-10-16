/* eslint-disable @typescript-eslint/no-explicit-any */
import { construirFechaHora } from '../../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { NotificacionItemDto } from '../../src/modules/notificaciones-correo/dto/sync-batch.dto';
import { SyncBatchService } from '../../src/modules/notificaciones-correo/sync-batch.service';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Correos «inteligentes» contra PostgreSQL real: enlazar compras que ya existen, plantillas por comercio (con el Trigger 6),
 * duplicados, productos por últimos 4 dígitos y reproceso de los pendientes.
 */
describeDb('Integración BD — correos inteligentes', () => {
  let s: Servicios;
  let semilla: Semilla;
  let amex: number; // tarjeta con los dígitos 1927 (aún sin asignar en la mayoría de pruebas)

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
    amex = semilla.tarjetaId;
    // sin dígitos: las tarjetas se asocian por evidencia o a mano
    await s.prisma.tarjetas.update({ where: { id: BigInt(amex) }, data: { descripcion: 'Amex', franquicia: 'American Express' } });
  });

  const item = (extra: Partial<NotificacionItemDto> = {}): NotificacionItemDto =>
    ({
      externalMessageId: '<m1@mail>',
      fecha: '2026-10-13',
      hora: '14:02:11',
      tipo: 'Compra',
      metodo: 'Tarjeta Credito',
      comercio: 'DL*DIDI FOOD CO',
      origenRaw: 'T.Cred *1927',
      valor: '50.000',
      moneda: 'COP',
      ...extra,
    }) as NotificacionItemDto;

  const compraManual = (concepto: string, valor: number, fecha: string, personaId?: number, tarjeta = amex) =>
    s.compras
      .save({ concepto, valorCompra: valor, fechaCompra: fecha, numeroCuotas: 1, interes: 0, descripcion: 'manual', estado: 'Pendiente', tarjeta }, semilla.userId)
      .then(async (id) => {
        if (personaId !== undefined) {
          await s.responsables.create({ persona: personaId, porcentajePago: 100, cantidadPago: valor, cantidadCuotas: 1, compraCredito: id } as any, semilla.userId);
        }
        return id;
      });

  /** Un correo tal como lo dejó el sync anterior: PENDIENTE, `datos_parseados` sin motivo nuevo y columnas nuevas vacías. */
  const pendienteAntiguo = (it: NotificacionItemDto) =>
    s.prisma.notificacionesCorreo.create({
      data: {
        owner_user_id: semilla.userId,
        external_message_id: it.externalMessageId,
        remitente: 'Bancolombia (Gmail)',
        asunto: it.asunto ?? `${it.tipo} · ${it.metodo}`,
        fecha_correo: construirFechaHora(it.fecha, it.hora) as Date,
        cuerpo_extraido: it.cuerpoExtraido ?? null,
        estado_procesamiento: 'PENDIENTE',
        datos_parseados: {
          tipo: it.tipo,
          metodo: it.metodo,
          comercio: it.comercio ?? null,
          origenRaw: it.origenRaw ?? null,
          valor: it.valor ?? null,
          moneda: it.moneda ?? 'COP',
          fecha: it.fecha,
          hora: it.hora,
          ruta: 'COMPRA_TC',
          motivo: 'tarjeta_no_identificada',
        },
      },
    });

  /** Servicio de sync SIN el aprendizaje automático al final (para probar las sugerencias aparte). */
  const syncSinAprender = () => new SyncBatchService(s.prisma, s.ejecutorCorreos, { inferirTarjetas: async () => [] } as any);

  const asignarTarjeta = (ultimos4: string, id = amex) => s.productosCorreo.asignar({ ultimos4, destino: 'TARJETA', id }, semilla.userId);

  async function esperar(jobId: string) {
    for (let i = 0; i < 200; i++) {
      const e = s.reproceso.estado(jobId, semilla.userId);
      if (e.estado !== 'EN_CURSO') return e;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('El reproceso no terminó');
  }

  it('una compra ya registrada a mano se ENLAZA al correo: no se duplica ni se borra al descartar', async () => {
    await asignarTarjeta('1927');
    const manual = await compraManual('DIDI FOODS', 50000, '2026-10-13', semilla.andresId);

    const r = await s.syncBatch.syncBatch([item()], semilla.userId);

    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'CONCILIADO', motivo: 'vinculada_a_compra_existente', vinculo: 'EXISTENTE', compraCreditoId: manual });
    expect(await s.prisma.comprasCredito.count()).toBe(1);
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    expect(nota).toMatchObject({ vinculo: 'EXISTENTE', ultimos_4: '1927', moneda: 'COP', tarjeta_id: BigInt(amex), compra_credito_generada_id: BigInt(manual) });
    expect(nota.comercio_normalizado).toBe('didi food');
    expect(nota.monto_original?.toString()).toBe('50000');

    // descartar el correo NO elimina la compra del usuario
    await s.notificaciones.conciliar(Number(nota.id), { accion: 'DESCARTAR' } as any, semilla.userId);
    expect(await s.prisma.comprasCredito.count()).toBe(1);
    const despues = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    expect(despues).toMatchObject({ estado_procesamiento: 'IGNORADO', compra_credito_generada_id: null });
  });

  it('el mismo gasto avisado dos veces crea UNA sola compra; un gasto igual horas después es otra compra', async () => {
    await asignarTarjeta('1927');
    await s.syncBatch.syncBatch(
      [
        item({ externalMessageId: '<a>', comercio: 'EXITO', hora: '10:00:00' }),
        item({ externalMessageId: '<b>', comercio: 'EXITO', hora: '10:03:00' }), // el banco avisó dos veces
        item({ externalMessageId: '<c>', comercio: 'EXITO', hora: '17:30:00' }), // otra compra igual, más tarde
      ],
      semilla.userId,
    );
    expect(await s.prisma.comprasCredito.count()).toBe(2);
    const estados = await s.prisma.notificacionesCorreo.findMany({ orderBy: { id: 'asc' }, select: { external_message_id: true, estado_procesamiento: true, vinculo: true, notificacion_original_id: true } });
    expect(estados.map((n) => [n.external_message_id, n.estado_procesamiento, n.vinculo])).toEqual([
      ['<a>', 'PENDIENTE', 'CREADA'],
      ['<b>', 'IGNORADO', 'DUPLICADO'],
      ['<c>', 'PENDIENTE', 'CREADA'],
    ]);
    expect(estados[1].notificacion_original_id).not.toBeNull();
  });

  it('plantilla: la compra nueva de un comercio habitual nace con las cuotas y los responsables de las anteriores (Trigger 6 incluido)', async () => {
    await asignarTarjeta('1927');
    // historial: 3 compras de DIDI ya registradas y enlazadas a sus correos (el usuario las revisó: CONCILIADO / EXISTENTE)
    const fechas = ['2026-09-01', '2026-09-08', '2026-09-15'];
    for (const [i, f] of fechas.entries()) await compraManual(['DIDI FOODS', 'DIDI FOOD', 'PIZZAS DIDI'][i], 40000 + i, f, semilla.andresId);
    await s.syncBatch.syncBatch(
      fechas.map((f, i) => item({ externalMessageId: `<h${i}>`, fecha: f, valor: String(40000 + i), hora: '12:00:00' })),
      semilla.userId,
    );
    expect(await s.prisma.comprasCredito.count()).toBe(3); // solo se enlazaron

    const r = await s.syncBatch.syncBatch([item({ externalMessageId: '<nueva>', fecha: '2026-10-13', valor: '62.500' })], semilla.userId);

    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'CONCILIADO', motivo: 'compra_creada_desde_plantilla', vinculo: 'CREADA' });
    const nueva = await s.prisma.comprasCredito.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(nueva).toMatchObject({ numero_cuotas: 1, tarjeta: BigInt(amex) });
    expect(nueva.concepto).toBe('Didi Food'); // los conceptos del usuario varían: nombre limpio del comercio
    const resp = await s.prisma.responsablesComprasCredito.findMany({ where: { compra_credito: nueva.id } });
    expect(resp.map((x) => [Number(x.persona), x.porcentaje_pago?.toString(), x.cantidad_pago?.toString(), x.cantidad_cuotas])).toEqual([[semilla.andresId, '100', '62500', 1]]);
    // Trigger 6: la deuda de Andrés llegó al sub-ledger sin que NestJS la calculara
    const cargos = await s.prisma.movimientosDeudaPersona.findMany({ where: { persona_id: BigInt(semilla.andresId), cuota_detalle: { compra: nueva.id } } });
    expect(cargos).toHaveLength(1);
    expect(cargos[0].monto.toString()).toBe('62500');
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow({ where: { external_message_id: '<nueva>' } });
    expect((nota.datos_parseados as any).plantilla).toMatchObject({ muestras: 3, origen: 'historial' });
  });

  it('un comercio nuevo se crea a 1 cuota, sin responsables y PENDIENTE (el usuario la completa)', async () => {
    await asignarTarjeta('1927');
    const r = await s.syncBatch.syncBatch([item({ comercio: 'LIBRERIA NUEVA' })], semilla.userId);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'PENDIENTE', motivo: 'compra_tc_creada_a_1_cuota' });
    expect(await s.prisma.responsablesComprasCredito.count()).toBe(0);
  });

  it('productos: sugiere y asocia solo la tarjeta con evidencia (compras con igual fecha y monto)', async () => {
    // 4 compras registradas en la tarjeta 1 con sus correos (T.Cred *1927) y 1 sola coincidencia para *5052
    const fechas = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    for (const [i, f] of fechas.entries()) await compraManual(`Gasto ${i}`, 10000 + i, f);
    await compraManual('Otro', 99000, '2026-09-10');
    await syncSinAprender().syncBatch(
      [
        ...fechas.map((f, i) => item({ externalMessageId: `<a${i}>`, fecha: f, valor: String(10000 + i), hora: '09:00:00', comercio: `GASTO ${i}` })),
        item({ externalMessageId: '<z>', fecha: '2026-09-10', valor: '99.000', origenRaw: 'T.Cred *5052', hora: '09:00:00' }),
      ],
      semilla.userId,
    );

    const productos = await s.productosCorreo.listar(semilla.userId);
    const p1927 = productos.find((p) => p.ultimos4 === '1927');
    const p5052 = productos.find((p) => p.ultimos4 === '5052');
    expect(p1927).toMatchObject({ instrumento: 'TC', correos: 4, asignadoA: null, sugerencia: { tipo: 'TARJETA_EXISTENTE', tarjetaId: amex, votos: 4, total: 4, automatica: true } });
    expect(p5052?.sugerencia).toMatchObject({ tipo: 'TARJETA_EXISTENTE', votos: 1, automatica: false }); // evidencia insuficiente

    const aprendidos = await s.productosCorreo.inferirTarjetas(semilla.userId, { aplicar: false });
    expect(aprendidos.map((a) => [a.ultimos4, a.aplicado])).toEqual([['1927', false]]);
    expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: BigInt(amex) } })).ultimos_4_digitos).toBeNull(); // simular no escribe

    const aplicados = await s.productosCorreo.inferirTarjetas(semilla.userId, { aplicar: true });
    expect(aplicados).toHaveLength(1);
    expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: BigInt(amex) } })).ultimos_4_digitos).toBe('1927');
    expect((await s.productosCorreo.listar(semilla.userId)).find((p) => p.ultimos4 === '1927')?.asignadoA).toMatchObject({ tipo: 'TARJETA', id: amex });
  });

  it('el sync-batch aprende solo: tras un lote con evidencia suficiente la tarjeta queda con sus dígitos', async () => {
    const fechas = ['2026-09-01', '2026-09-02', '2026-09-03'];
    for (const [i, f] of fechas.entries()) await compraManual(`Gasto ${i}`, 20000 + i, f);
    const r = await s.syncBatch.syncBatch(
      fechas.map((f, i) => item({ externalMessageId: `<a${i}>`, fecha: f, valor: String(20000 + i), hora: '09:00:00', comercio: `GASTO ${i}` })),
      semilla.userId,
    );
    // sin la tarjeta asignada todavía, los correos se enlazaron por coincidencia inequívoca
    expect(r.detalle.every((d) => d.vinculo === 'EXISTENTE')).toBe(true);
    expect(r.aprendizajes).toEqual([expect.objectContaining({ ultimos4: '1927', tarjetaId: amex, aplicado: true })]);
    expect((await s.prisma.tarjetas.findUniqueOrThrow({ where: { id: BigInt(amex) } })).ultimos_4_digitos).toBe('1927');
  });

  it('asignar: conflicto si los dígitos ya son de otro producto; crea cuentas/tarjetas con ellos; la cuenta principal es única', async () => {
    await asignarTarjeta('1927');
    await expect(s.productosCorreo.asignar({ ultimos4: '1927', destino: 'CUENTA', id: semilla.bancolombiaId }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    await expect(s.productosCorreo.asignar({ ultimos4: '0001', destino: 'CUENTA' } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });

    const nueva = await s.productosCorreo.asignar({ ultimos4: '3698', destino: 'CUENTA', nuevo: { nombre: 'Ahorros Bancolombia', esPrincipal: true } }, semilla.userId);
    expect(nueva).toMatchObject({ creado: true, nombre: 'Ahorros Bancolombia' });
    await s.productosCorreo.asignar({ ultimos4: '4278', destino: 'CUENTA', id: nueva.id }, semilla.userId);
    expect((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(nueva.id) } })).ultimos_4_digitos).toBe('3698,4278');

    const otra = await s.productosCorreo.asignar({ ultimos4: '4248', destino: 'CUENTA', nuevo: { nombre: 'Bre-B', esPrincipal: true } }, semilla.userId);
    const principales = await s.prisma.cuentasFinancieras.findMany({ where: { es_principal: true } });
    expect(principales.map((c) => Number(c.id))).toEqual([otra.id]); // marcar una desmarca la anterior

    const tarjetaNueva = await s.productosCorreo.asignar({ ultimos4: '9491', destino: 'TARJETA', nuevo: { franquicia: 'Mastercard' } }, semilla.userId);
    expect(tarjetaNueva).toMatchObject({ creado: true, destino: 'TARJETA' });
  });

  it('cuentas: Bre-B enviado y recibido, nómina sin número (cuenta principal), persona reconocida y saldo por el Trigger 2', async () => {
    const cuenta = await s.productosCorreo.asignar({ ultimos4: '3698', destino: 'CUENTA', nuevo: { nombre: 'Ahorros', esPrincipal: true, saldoInicial: 1000000 } }, semilla.userId);
    await s.productosCorreo.asignar({ ultimos4: '4248', destino: 'CUENTA', nuevo: { nombre: 'Bre-B' } }, semilla.userId);
    await s.prisma.personas.update({ where: { id: BigInt(semilla.andresId) }, data: { nombre: 'Andrés Felipe Gómez Ruiz' } });

    const r = await s.syncBatch.syncBatch(
      [
        item({ externalMessageId: '<bre>', tipo: 'Transferencia', metodo: 'Transfiya/Bre-b', comercio: 'ANDRES FELIPE GOMEZ RUIZ (Llave: 3108892985)', origenRaw: 'Cuenta *4248', valor: '250.000', hora: '10:00:00' }),
        item({
          externalMessageId: '<rec>',
          tipo: 'Desconocido',
          metodo: 'Transfiya/Bre-b',
          comercio: '',
          origenRaw: '',
          valor: '2000000',
          hora: '11:00:00',
          cuerpoExtraido: 'Bancolombia: luis, recibiste una transferencia de ANDRES FELIPE GOMEZ RUIZ por $2,000,000.00 en tu cuenta *4248 conectada a la llave @luish9910 el 13/10/26 a las 11:00.',
        }),
        item({ externalMessageId: '<nomina>', tipo: 'Ingreso', metodo: 'Cuenta Ahorros', comercio: 'PRAGMA S A', origenRaw: 'cuenta de Ahorros', valor: '5.000.000', hora: '12:00:00' }),
        item({ externalMessageId: '<rechazo>', tipo: 'Desconocido', metodo: 'Tarjeta Credito', origenRaw: 'Tarjeta Crédito', valor: '204676', hora: '13:00:00', cuerpoExtraido: 'tu compra con T.Credito *9491 por COP204.676,00 no fue exitosa por fondos insuficientes.' }),
      ],
      semilla.userId,
    );
    expect(r.errores).toEqual([]);
    expect(r.detalle.map((d) => [d.externalMessageId, d.estadoProcesamiento, d.motivo])).toEqual([
      ['<bre>', 'CONCILIADO', 'transaccion_confirmada_automaticamente'],
      ['<rec>', 'CONCILIADO', 'transaccion_confirmada_automaticamente'],
      ['<nomina>', 'CONCILIADO', 'transaccion_confirmada_automaticamente'],
      ['<rechazo>', 'IGNORADO', 'compra_rechazada_o_no_exitosa'],
    ]);

    const saldos = Object.fromEntries((await s.prisma.cuentasFinancieras.findMany()).map((c) => [c.nombre, c.saldo_actual.toString()]));
    expect(saldos['Bre-B']).toBe('1750000'); // −250.000 + 2.000.000
    expect(saldos['Ahorros']).toBe('6000000'); // 1.000.000 + nómina 5.000.000 (cuenta principal)
    void cuenta;
    const notas = await s.prisma.notificacionesCorreo.findMany({ orderBy: { id: 'asc' } });
    expect(notas[0]).toMatchObject({ persona_id: BigInt(semilla.andresId), ultimos_4: '4248' });
    expect(notas[1]).toMatchObject({ persona_id: BigInt(semilla.andresId), ultimos_4: '4248' });
    const recibida = await s.prisma.transacciones.findFirstOrThrow({ where: { concepto: { startsWith: 'Transferencia recibida' } } });
    expect(recibida.concepto).toBe('Transferencia recibida de ANDRES FELIPE GOMEZ RUIZ');
  });

  it('DESCARTAR deshace lo que el sync confirmó (anula la transacción y devuelve el saldo)', async () => {
    const c = await s.productosCorreo.asignar({ ultimos4: '3698', destino: 'CUENTA', nuevo: { nombre: 'Ahorros', saldoInicial: 100000 } }, semilla.userId);
    await s.syncBatch.syncBatch([item({ tipo: 'Retiro', metodo: 'Cuenta Ahorros', origenRaw: 'cta *3698', comercio: 'CAJERO', valor: '30.000' })], semilla.userId);
    const saldo = async () => (await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(c.id) } })).saldo_actual.toString();
    expect(await saldo()).toBe('70000');
    const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();
    await s.notificaciones.conciliar(Number(nota.id), { accion: 'DESCARTAR' } as any, semilla.userId);
    expect(await saldo()).toBe('100000');
    expect((await s.prisma.transacciones.findFirstOrThrow()).estado).toBe('ANULADO');
  });

  it('una transacción registrada a mano se enlaza al correo en vez de duplicarse', async () => {
    const c = await s.productosCorreo.asignar({ ultimos4: '3698', destino: 'CUENTA', nuevo: { nombre: 'Ahorros' } }, semilla.userId);
    const manual = await s.transacciones.create(
      { tipoTransaccion: 'EGRESO', cuentaOrigenId: c.id, concepto: 'Retiro cajero', montoOriginal: 30000, fechaTransaccion: '2026-10-13T10:00:00-05:00' } as any,
      semilla.userId,
    );
    const r = await s.syncBatch.syncBatch([item({ tipo: 'Retiro', metodo: 'Cuenta Ahorros', origenRaw: 'cta *3698', comercio: 'CAJERO', valor: '30.000' })], semilla.userId);
    expect(r.detalle[0]).toMatchObject({ estadoProcesamiento: 'CONCILIADO', motivo: 'vinculada_a_transaccion_existente', transaccionId: Number(manual.id) });
    expect(await s.prisma.transacciones.count()).toBe(1);
  });

  it('reproceso: simula sin escribir y después pone al día los pendientes (enlaza, crea con plantilla, respeta la fecha de corte)', async () => {
    // 1) Estado real de hoy: ~todo quedó PENDIENTE porque la tarjeta no estaba identificada
    const ya = [
      ['2026-05-02', 11000, 'DIDI FOODS'],
      ['2026-05-09', 12000, 'DIDI FOOD'],
      ['2026-05-16', 13000, 'PIZZAS DIDI'],
    ] as const;
    for (const [f, v, c] of ya) await compraManual(c, v, f, semilla.andresId);
    const lote: NotificacionItemDto[] = ya.map(([f, v], i) => item({ externalMessageId: `<ya${i}>`, fecha: f, valor: String(v), hora: '12:00:00' }));
    lote.push(item({ externalMessageId: '<viejo>', fecha: '2025-01-10', valor: '77.000', hora: '12:00:00', comercio: 'TIENDA ANTIGUA' })); // sin compra equivalente, antes del corte
    lote.push(item({ externalMessageId: '<nuevo1>', fecha: '2026-10-10', valor: '30.000', hora: '12:00:00' })); // DIDI → plantilla
    lote.push(item({ externalMessageId: '<nuevo2>', fecha: '2026-10-12', valor: '45.000', hora: '12:00:00', comercio: 'FERRETERIA PEPE' })); // comercio nuevo
    lote.push(item({ externalMessageId: '<nuevo2b>', fecha: '2026-10-12', valor: '45.000', hora: '12:02:00', comercio: 'FERRETERIA PEPE' })); // duplicado del anterior
    lote.push(item({ externalMessageId: '<rechazo>', tipo: 'Desconocido', origenRaw: 'Tarjeta Crédito', valor: '1000', hora: '13:00:00', cuerpoExtraido: 'tu compra no fue exitosa por fondos insuficientes' }));
    for (const it of lote) await pendienteAntiguo(it);
    expect(await s.prisma.notificacionesCorreo.count({ where: { estado_procesamiento: 'PENDIENTE' } })).toBe(8);
    expect(await s.prisma.comprasCredito.count()).toBe(3);

    // 2) El usuario asigna los dígitos a la tarjeta y simula
    await asignarTarjeta('1927');
    const sim: any = await s.reproceso.reprocesar({ simular: true, desde: '2026-06-01' } as any, semilla.userId);
    expect(sim.simulado).toBe(true);
    expect(sim.evaluados).toBe(8);
    expect(sim.acciones).toEqual({ compras_enlazadas: 3, compras_creadas_con_plantilla: 1, compras_creadas: 1, duplicados: 1, ignorados: 1, siguen_pendientes: 1 });
    expect(sim.motivos).toMatchObject({ historico_sin_registro_previo: 1, vinculada_a_compra_existente: 3 });
    expect(await s.prisma.comprasCredito.count()).toBe(3); // la simulación no escribió nada
    expect(await s.prisma.notificacionesCorreo.count({ where: { estado_procesamiento: 'PENDIENTE' } })).toBe(8);
    expect((await s.prisma.notificacionesCorreo.findFirstOrThrow({ where: { external_message_id: '<ya0>' } })).ultimos_4).toBeNull(); // sin tocar

    // 3) Ejecución en segundo plano
    const inicio: any = await s.reproceso.reprocesar({ simular: false, desde: '2026-06-01' } as any, semilla.userId);
    expect(inicio.jobId).toEqual(expect.any(String));
    const fin = await esperar(inicio.jobId);
    expect(fin.estado).toBe('TERMINADO');
    expect(fin.resumen?.acciones).toEqual(sim.acciones); // la ejecución decide igual que la simulación
    expect(fin.resumen?.errores).toEqual([]);

    expect(await s.prisma.comprasCredito.count()).toBe(5); // 3 manuales + 1 con plantilla + 1 nueva
    const estados = await s.prisma.notificacionesCorreo.groupBy({ by: ['estado_procesamiento'], _count: true });
    expect(Object.fromEntries(estados.map((e) => [e.estado_procesamiento, e._count]))).toEqual({ CONCILIADO: 4, PENDIENTE: 2, IGNORADO: 2 });
    const plantilla = await s.prisma.comprasCredito.findFirstOrThrow({ where: { fecha_compra: new Date('2026-10-10T00:00:00Z') } });
    expect((await s.prisma.responsablesComprasCredito.findMany({ where: { compra_credito: plantilla.id } })).map((r) => Number(r.persona))).toEqual([semilla.andresId]);
    const viejo = await s.prisma.notificacionesCorreo.findFirstOrThrow({ where: { external_message_id: '<viejo>' } });
    expect(viejo).toMatchObject({ estado_procesamiento: 'PENDIENTE', compra_credito_generada_id: null });

    // 4) Es idempotente: reprocesar de nuevo no crea nada más
    const otra: any = await s.reproceso.reprocesar({ simular: true, desde: '2026-06-01' } as any, semilla.userId);
    expect(otra.acciones).toEqual({ siguen_pendientes: 1 }); // solo «viejo»; la compra nueva sin plantilla espera su revisión
    expect(await s.prisma.comprasCredito.count()).toBe(5);
  });

  it('el estado de un reproceso ajeno no se puede consultar', async () => {
    await asignarTarjeta('1927');
    const inicio: any = await s.reproceso.reprocesar({ simular: false } as any, semilla.userId);
    await esperar(inicio.jobId);
    expect(() => s.reproceso.estado(inicio.jobId, 999n)).toThrow(/no encontrado/);
  });
});
