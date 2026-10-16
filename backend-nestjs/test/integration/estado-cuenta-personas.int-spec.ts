/* eslint-disable @typescript-eslint/no-explicit-any */
import { CompraCreditoInput } from '../../src/modules/compras-credito/dto/compra-credito.dto';
import { crearServicios, describeDb, mesRelativo, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Estado de cuenta por persona contra PostgreSQL real: lo que compré con mi tarjeta y le toca a un tercero (porcentaje × cuota,
 * solo las primeras N cuotas) se suma a «lo que debe este mes» y a «su deuda total», con el desglose por tarjeta y por compra,
 * y los abonos saldan primero las cuotas más antiguas.
 */
describeDb('Integración BD — estado de cuenta por persona (deuda unificada con tarjetas)', () => {
  let s: Servicios;
  let semilla: Semilla;
  const P = mesRelativo(0);

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

  const compra = (extra: Partial<CompraCreditoInput>): CompraCreditoInput => ({
    concepto: 'Nevera',
    valorCompra: 1200000,
    fechaCompra: `${mesRelativo(-1)}-10`,
    numeroCuotas: 12,
    interes: 0,
    descripcion: 'Éxito',
    estado: 'Pendiente',
    tarjeta: semilla.tarjetaId,
    ...extra,
  });

  /** A: nevera 12 cuotas desde el mes pasado, Andrés 50 %. B: celular 6 cuotas desde este mes, Andrés 100 % pero solo las 3 primeras. */
  async function sembrarCompras() {
    const a = await s.compras.save(compra({}), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: a }, semilla.userId);
    await s.responsables.create({ persona: semilla.yoId, porcentajePago: 50, cantidadPago: 600000, cantidadCuotas: 12, compraCredito: a }, semilla.userId);
    const b = await s.compras.save(compra({ concepto: 'Celular', valorCompra: 600000, numeroCuotas: 6, fechaCompra: `${P}-05` }), semilla.userId);
    await s.responsables.create({ persona: semilla.andresId, porcentajePago: 100, cantidadPago: 300000, cantidadCuotas: 3, compraCredito: b }, semilla.userId);
    return { a, b };
  }

  const fila = async (personaId = semilla.andresId) => (await s.estadoCuentaPersonas.listar(semilla.userId, P)).personas.find((p) => p.persona.id === personaId);
  const n = (x: { toString(): string }) => x.toString();

  it('suma lo que le toca de cada compra con tarjeta: pago del mes, por vencer y deuda total', async () => {
    await sembrarCompras();
    const andres = (await fila())!;

    expect(n(andres.pagoDelMes)).toBe('150000'); // nevera 50 % (50000) + celular cuota 1 (100000)
    expect(n(andres.pagoDelMesTarjetas)).toBe('150000');
    expect(n(andres.saldoAnterior)).toBe('50000'); // cuota 1 de la nevera (mes pasado), aún sin pagar
    expect(n(andres.saldoExigible)).toBe('200000');
    expect(n(andres.aPagarAhora)).toBe('200000');
    expect(n(andres.porVencer)).toBe('700000'); // nevera 10 × 50000 + celular 2 × 100000 (solo 3 cuotas le tocan, no 6)
    expect(n(andres.deudaTotal)).toBe('900000'); // 12 × 50000 + 3 × 100000
    expect(andres.estado).toBe('DEBE');
    expect(andres.historicoSinCargar).toEqual({ cuotas: 0, monto: expect.anything() });

    expect(andres.porTarjeta).toHaveLength(1);
    expect(andres.porTarjeta[0]).toMatchObject({ tarjeta: expect.stringContaining('Visa'), numeroCompras: 2 });
    expect(n(andres.porTarjeta[0].totalMes)).toBe('150000');
    expect(n(andres.porTarjeta[0].porVencer)).toBe('700000');
  });

  it('el propietario no aparece como deudor de sí mismo ni quien no tiene nada', async () => {
    await sembrarCompras();
    const { personas, totales } = await s.estadoCuentaPersonas.listar(semilla.userId, P);

    expect(personas.map((p) => p.persona.id)).toEqual([semilla.andresId]);
    expect(n(totales.deudaTotal)).toBe('900000');
    expect(n(totales.pagoDelMes)).toBe('150000');

    const todas = await s.estadoCuentaPersonas.listar(semilla.userId, P, { todas: true });
    expect(todas.personas.map((p) => p.persona.id).sort()).toEqual([semilla.andresId, semilla.papaId, semilla.yoId].sort());
  });

  it('detalle: compras de la tarjeta con cuota k de N, porcentaje y lo que queda por pagar', async () => {
    await sembrarCompras();
    const d = await s.estadoCuentaPersonas.detalle(semilla.userId, semilla.andresId, P);

    expect(d.desglosePorTarjeta).toHaveLength(1);
    const compras = d.desglosePorTarjeta[0].compras!;
    const nevera = compras.find((c) => c.concepto === 'Nevera')!;
    const celular = compras.find((c) => c.concepto === 'Celular')!;

    expect(n(nevera.porcentaje)).toBe('50');
    expect(nevera.numeroCuotasCompra).toBe(12);
    expect(nevera.cuotaDelMes).toMatchObject({ numero: 2, estado: 'PENDIENTE' });
    expect(n(nevera.cuotaDelMes!.monto)).toBe('50000');
    expect(nevera.restantes.cuotas).toBe(10);
    expect(n(nevera.restantes.monto)).toBe('500000');

    expect(n(celular.porcentaje)).toBe('100');
    expect(celular.cuotasDeLaPersona).toBe(3);
    expect(celular.cuotaDelMes).toMatchObject({ numero: 1 });
    expect(n(celular.cuotaDelMes!.monto)).toBe('100000');
    expect(celular.restantes.cuotas).toBe(2);
    expect(n(celular.restantes.monto)).toBe('200000');

    // la cuota del mes pasado sigue sin pagar y se lista aparte
    expect(d.cuotasAnterioresPendientes).toHaveLength(1);
    expect(d.cuotasAnterioresPendientes[0]).toMatchObject({ concepto: 'Nevera', numeroCuota: 1, estado: 'PENDIENTE' });
  });

  it('los abonos saldan primero las cuotas más antiguas (FIFO) y reducen lo que debe ahora', async () => {
    await sembrarCompras();
    await s.subledger.abonarPersona(semilla.andresId, { cuentaDestinoId: semilla.bancolombiaId, monto: 120000, periodoImputacion: P, concepto: 'Abono' } as any, semilla.userId);

    const andres = (await fila())!;
    expect(n(andres.saldoExigible)).toBe('80000'); // 200000 − 120000
    expect(n(andres.deudaTotal)).toBe('780000'); // 900000 − 120000

    const d = await s.estadoCuentaPersonas.detalle(semilla.userId, semilla.andresId, P);
    const nevera = d.desglosePorTarjeta[0].compras!.find((c) => c.concepto === 'Nevera')!;
    const celular = d.desglosePorTarjeta[0].compras!.find((c) => c.concepto === 'Celular')!;
    expect(d.cuotasAnterioresPendientes).toHaveLength(0); // la cuota 1 de la nevera quedó pagada
    expect(nevera.cuotaDelMes).toMatchObject({ estado: 'PAGADA' });
    expect(celular.cuotaDelMes).toMatchObject({ estado: 'PARCIAL' });
    expect(n(celular.cuotaDelMes!.cubierto)).toBe('20000');
    expect(n(celular.cuotaDelMes!.pendiente)).toBe('80000');
  });

  it('compras anteriores a los triggers (sin asiento) cuentan este mes y lo viejo se reporta aparte sin inflar el saldo', async () => {
    await sembrarCompras();
    await s.prisma.movimientosDeudaPersona.deleteMany({}); // como si la compra se hubiera cargado antes del sub-ledger

    const andres = (await fila())!;
    expect(n(andres.pagoDelMes)).toBe('150000'); // se calcula desde las compras
    expect(n(andres.saldoAnterior)).toBe('0'); // el mes pasado no se inventa como deuda...
    expect(andres.historicoSinCargar.cuotas).toBe(1); // ...pero se avisa
    expect(n(andres.historicoSinCargar.monto)).toBe('50000');
    expect(n(andres.porVencer)).toBe('700000');
    expect(n(andres.deudaTotal)).toBe('850000');
  });

  it('cambiar el porcentaje o las cuotas de un responsable se refleja al instante', async () => {
    const { b } = await sembrarCompras();
    const resp = await s.prisma.responsablesComprasCredito.findFirstOrThrow({ where: { compra_credito: BigInt(b), persona: BigInt(semilla.andresId) } });
    await s.prisma.responsablesComprasCredito.update({ where: { id: resp.id }, data: { cantidad_cuotas: 6 } });

    const andres = (await fila())!;
    expect(n(andres.porVencer)).toBe('1000000'); // nevera 500000 + celular 5 × 100000
  });

  it('valida el periodo y la persona', async () => {
    await expect(s.estadoCuentaPersonas.listar(semilla.userId, '2026-13')).rejects.toBeDefined();
    await expect(s.estadoCuentaPersonas.detalle(semilla.userId, 999999, P)).rejects.toBeDefined();
  });
});
