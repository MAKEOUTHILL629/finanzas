/* eslint-disable @typescript-eslint/no-explicit-any */
import { CompraCreditoInput } from '../../src/modules/compras-credito/dto/compra-credito.dto';
import { crearServicios, describeDb, finDeMes, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Compras a crédito ↔ triggers 1, 6 y 8 del sub-ledger, en PostgreSQL real.
 * (Reglas 3 y 4: no duplicar la lógica de los triggers; recalcular cuotas sin romper FKs.)
 */
describeDb('Integración BD — compras a crédito y sub-ledger (Triggers 1, 6, 8)', () => {
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

  // Primera cuota 2 meses adelante: siempre futura → cuota 1 CONFIRMADO y el resto PROYECTADO (Trigger 6) sin importar la fecha de ejecución.
  const base = mesRelativo(2);
  const compra = (extra: Partial<CompraCreditoInput> = {}): CompraCreditoInput => ({
    concepto: 'Nevera',
    valorCompra: 1200000,
    fechaCompra: `${base}-10`, // 10 ≤ 15 → primera cuota a fin de ese mes (futuro respecto a "hoy")
    numeroCuotas: 12,
    interes: 0,
    descripcion: 'Éxito',
    estado: 'Pendiente',
    tarjeta: semilla.tarjetaId,
    ...extra,
  });

  const movimientosDe = (compraId: number) =>
    s.prisma.movimientosDeudaPersona.findMany({
      where: { cuota_detalle: { compra: BigInt(compraId) } },
      include: { cuota_detalle: true },
      orderBy: { cuota_detalle: { numero_cuota: 'asc' } },
    });

  it('save: cabecera + cuotas con periodo_facturacion (Trigger 1) y montos exactos en numeric', async () => {
    const id = await s.compras.save(compra({ interes: 2 }), semilla.userId);

    const cabecera = await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(cabecera.owner_user_id).toBe(semilla.userId);
    expect(cabecera.valor_compra?.toString()).toBe('1200000');
    expect(cabecera.moneda_original).toBe('COP');
    expect(cabecera.trm_confirmada).toBe(true);
    expect(cabecera.fecha_ultima_cuota?.toISOString().slice(0, 10)).toBe(finDeMes(mesRelativo(13)));
    expect(cabecera.pago_mensual?.toString()).toBe('102000'); // 100000 + 2 % de 100000

    const cuotas = await s.cuotas.listByCompra(id, semilla.userId);
    expect(cuotas).toHaveLength(12);
    expect(cuotas[0]).toMatchObject({ numeroCuota: 1, interesPagado: 0, aporteCapital: 100000, pagoTotal: 100000, saldoRestante: 1100000 });
    expect(cuotas[1]).toMatchObject({ numeroCuota: 2, interesPagado: 46000, pagoTotal: 146000 });
    expect(cuotas[11].saldoRestante).toBe(0);

    const periodos = await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' }, select: { periodo_facturacion: true } });
    expect(periodos[0].periodo_facturacion).toBe(base);
    expect(periodos[11].periodo_facturacion).toBe(mesRelativo(13));
  });

  it('el responsable TERCERO genera los cargos CARGO_CUOTA_TC (Trigger 6); el dueño no', async () => {
    const id = await s.compras.save(compra(), semilla.userId);

    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    await s.responsables.create({ persona: semilla.yoId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: id }, semilla.userId);

    const movs = await movimientosDe(id);
    expect(movs).toHaveLength(12); // solo Andrés
    expect(movs.every((m) => m.persona_id === BigInt(semilla.andresId))).toBe(true);
    expect(movs.every((m) => m.tipo_movimiento === 'CARGO_CUOTA_TC' && m.signo === 1)).toBe(true);
    expect(movs.every((m) => m.monto.toString() === '50000')).toBe(true);
    expect(movs[0].estado).toBe('CONFIRMADO'); // cuota 1
    expect(movs[1].estado).toBe('PROYECTADO'); // cuotas futuras
    expect(movs[0].periodo_imputacion).toBe(base);
  });

  it('Regla 4 (mismo nº de cuotas): UPDATE de cuotas → el Trigger 8 actualiza los MISMOS asientos, sin FK rotas', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    const antes = await movimientosDe(id);
    const idsCuotasAntes = (await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } })).map((c) => c.id);

    // sube el interés a 2 %: cuota 2 = 146000 (acumulado 24000 + 22000), cuota 3 = 120000
    await s.compras.updateCompra(id, compra({ interes: 2 }), semilla.userId);

    const despues = await movimientosDe(id);
    expect(despues.map((m) => m.id)).toEqual(antes.map((m) => m.id)); // mismos asientos: no se recrearon
    expect(despues).toHaveLength(12);
    expect(despues[0].monto.toString()).toBe('50000');
    expect(despues[1].monto.toString()).toBe('73000'); // 146000 × 50 %
    expect(despues[2].monto.toString()).toBe('60000'); // 120000 × 50 %
    const idsCuotasDespues = (await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } })).map((c) => c.id);
    expect(idsCuotasDespues).toEqual(idsCuotasAntes); // mismas filas de CuotasDetalle
  });

  it('Regla 4 (cambia nº de cuotas): borra asientos, recrea cuotas y el Trigger 6 regenera el sub-ledger', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    expect(await movimientosDe(id)).toHaveLength(12);

    await s.compras.updateCompra(id, compra({ numeroCuotas: 6, valorCompra: 600000 }), semilla.userId);

    const cuotas = await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } });
    expect(cuotas).toHaveLength(6);
    const movs = await movimientosDe(id);
    expect(movs).toHaveLength(6);
    expect(movs.every((m) => m.monto.toString() === '50000')).toBe(true); // 100000 × 50 %
    // ningún asiento huérfano apuntando a cuotas que ya no existen
    const total = await s.prisma.movimientosDeudaPersona.count({ where: { persona_id: BigInt(semilla.andresId) } });
    expect(total).toBe(6);
  });

  it('actualizar el responsable a menos cuotas elimina los asientos sobrantes', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    const rid = await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    await s.responsables.update({ id: rid, persona: semilla.andresId, porcentajePago: 25, cantidadPago: 0, cantidadCuotas: 4, compraCredito: id }, semilla.userId);

    const movs = await movimientosDe(id);
    expect(movs).toHaveLength(4);
    expect(movs.every((m) => m.monto.toString() === '25000')).toBe(true); // 100000 × 25 %
  });

  it('eliminar un responsable limpia su sub-ledger (FK estricta)', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    const rid = await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    await s.responsables.delete(rid, semilla.userId);
    expect(await s.prisma.movimientosDeudaPersona.count()).toBe(0);
    expect(await s.prisma.responsablesComprasCredito.count()).toBe(0);
  });

  it('delete en cascada: sub-ledger → responsables → cuotas → compra (sin violar FKs)', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);

    await s.compras.delete(id, semilla.userId);

    expect(await s.prisma.comprasCredito.count()).toBe(0);
    expect(await s.prisma.cuotasDetalle.count()).toBe(0);
    expect(await s.prisma.responsablesComprasCredito.count()).toBe(0);
    expect(await s.prisma.movimientosDeudaPersona.count()).toBe(0);
  });

  it('aislamiento multi-tenant: otro usuario no ve ni borra mis compras', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', is_active: true } });

    expect(await s.compras.list(otro.id)).toEqual([]);
    expect(await s.compras.getById(id, otro.id)).toBeNull();
    expect(await s.cuotas.listByCompra(id, otro.id)).toEqual([]);
    await expect(s.compras.delete(id, otro.id)).rejects.toThrow('No se encontró la compra');
    expect(await s.prisma.comprasCredito.count()).toBe(1);
  });

  it('list devuelve responsables "id,id" y la suma de porcentajes como el JOIN legacy', async () => {
    const id = await s.compras.save(compra(), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    await s.responsables.create({ persona: semilla.papaId, porcentajePago: 25.5, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    const [fila] = await s.compras.list(semilla.userId);
    expect(fila.responsables).toBe(`${semilla.andresId},${semilla.papaId}`);
    expect(fila.porcentajePago).toBe(75.5);
  });

  it('ajusteInteres: cuotas futuras quedan en "Ajuste Interes" y el sub-ledger no se rompe', async () => {
    const id = await s.compras.save(compra({ interes: 2 }), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 0, cantidadCuotas: 12, compraCredito: id }, semilla.userId);
    const antes = await movimientosDe(id);

    await s.compras.ajusteInteresTarjetaCredito(semilla.tarjetaId, semilla.userId);

    const cabecera = await s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(cabecera.estado).toBe('Ajuste Interes');
    const cuotas = await s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } });
    expect(cuotas.every((c) => c.estado === 'Ajuste Interes')).toBe(true); // todas con fecha ≥ hoy
    expect(cuotas[0].interes_pagado?.toString()).toBe('24000'); // ahora cobra interés en la cuota 1
    const despues = await movimientosDe(id);
    expect(despues.map((m) => m.id)).toEqual(antes.map((m) => m.id));
    expect(despues[0].monto.toString()).toBe('62000'); // (100000 + 24000) × 50 %
    // y las consultas legacy las excluyen
    expect(await s.pagos.calcularPagoTarjetasCredito(semilla.userId)).toEqual([]);
  });

  it('pagar-productos y cambioEstado marcan como Pagado solo las compras vencidas', async () => {
    const vencida = await s.compras.save(compra({ fechaCompra: '2025-01-10', numeroCuotas: 2, valorCompra: 200000 }), semilla.userId);
    const vigente = await s.compras.save(compra(), semilla.userId);

    expect(await s.pagos.pagarProductosTarjetaCredito(semilla.userId)).toBe(1);

    const estados = await s.prisma.comprasCredito.findMany({ orderBy: { id: 'asc' } });
    expect(estados.find((c) => Number(c.id) === vencida)?.estado).toBe('Pagado');
    expect(estados.find((c) => Number(c.id) === vigente)?.estado).toBe('Pendiente');
    expect(await s.compras.cambioEstado(semilla.userId)).toBe(0);
  });

  it('CSV masivo contra la BD real (1 válida, 1 con tarjeta inexistente)', async () => {
    const csv = [
      'Fecha Compra;Concepto;Valor;Cuotas;Tarjeta;Interes;descripcion;estado',
      `15,11,2025;Laptop;1200000,50;12;${semilla.tarjetaId};2,5;Trabajo;`,
      '2026-11-01;Mesa;100;2;999;1;;',
    ].join('\n');
    const r = await s.csv.procesar(csv, semilla.userId);
    expect(r.exitosos).toBe(1);
    expect(r.errores).toBe(1);
    const [fila] = await s.compras.list(semilla.userId);
    expect(fila.concepto).toBe('Laptop');
    expect(fila.valorCompra).toBe(1200000.5);
    expect(fila.estado).toBe('Pendiente');
    expect(fila.fechaCompra).toBe(Date.UTC(2025, 10, 15)); // "15,11,2025" = 15 nov 2025
  });
});
