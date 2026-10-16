/* eslint-disable @typescript-eslint/no-explicit-any */
import { ComprasCreditoService } from '../src/modules/compras-credito/compras-credito.service';
import { createPrismaMock, dec, sqlDe, utc } from './helpers/prisma-mock';

const OWNER = 7n;
const HOY = utc('2024-06-15');

function compraBase(extra: Record<string, unknown> = {}) {
  return {
    id: 1n,
    created_at: new Date('2024-01-02T10:00:00Z'),
    concepto: 'Compra Test',
    valor_compra: dec('1000'),
    fecha_compra: utc('2024-01-10'),
    numero_cuotas: 10,
    fecha_ultima_cuota: utc('2024-10-31'),
    pago_mensual: dec('105'),
    interes: dec('5'),
    descripcion: 'Test',
    estado: 'Pendiente',
    tarjeta: 1234n,
    owner_user_id: OWNER,
    moneda_original: 'COP',
    valor_moneda_original: dec('1000'),
    tasa_cambio_aplicada: dec('1'),
    trm_confirmada: true,
    ...extra,
  };
}

function setup() {
  const prisma = createPrismaMock();
  const service = new ComprasCreditoService(prisma);
  return { prisma, service };
}

/** Port de `CompraCreditoServicioTest.scala` ("recalcularCuotas should recalculate the installments correctly"). */
describe('ComprasCreditoService.recalcularCuotas — port de CompraCreditoServicioTest.scala', () => {
  it('recalcula: reemplaza las cuotas, actualiza la compra y devuelve 1', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.cuotasDetalle.findMany.mockResolvedValue([]); // sin cuotas previas
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recalcularCuotas(1, OWNER);

    expect(result).toBe(1);
    expect(prisma.cuotasDetalle.deleteMany).toHaveBeenCalledTimes(1); // ≙ verify(deleteByCompra)
    expect(prisma.cuotasDetalle.createMany).toHaveBeenCalledTimes(1); // ≙ verify(saveBatch)
    expect(prisma.comprasCredito.updateMany).toHaveBeenCalledTimes(1); // ≙ verify(update)

    const { data } = prisma.cuotasDetalle.createMany.mock.calls[0][0];
    expect(data).toHaveLength(10);
    expect(data[0]).toMatchObject({ numero_cuota: 1n, compra: 1n, periodo_facturacion: '2024-01' });
    expect(data[9]).toMatchObject({ numero_cuota: 10n, periodo_facturacion: '2024-10' });

    const update = prisma.comprasCredito.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: 1n });
    expect(update.data.fecha_ultima_cuota.toISOString()).toBe('2024-10-31T00:00:00.000Z');
    expect(update.data.pago_mensual.toString()).toBe('105');
  });

  it('rechaza una compra que no es del usuario (multi-tenant)', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(null);
    await expect(service.recalcularCuotas(99, OWNER)).rejects.toThrow('No se encontró la compra con ID 99');
    expect(prisma.comprasCredito.findFirst.mock.calls[0][0].where).toEqual({ id: 99n, owner_user_id: OWNER });
  });

  it("si el concepto contiene 'Ajuste de Interes' cobra el interés en la cuota 1", async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase({ concepto: 'Compra X - Ajuste de Interes' }));
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.cuotasDetalle.findMany.mockResolvedValue([]);
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    await service.recalcularCuotas(1, OWNER);
    const { data } = prisma.cuotasDetalle.createMany.mock.calls[0][0];
    expect(data[0].interes_pagado.toString()).toBe('50'); // 5 % de 1000 ya en la cuota 1
    expect(data[0].pago_total.toString()).toBe('150');
  });
});

describe('Regla 4 — recalcular cuotas sin romper el sub-ledger', () => {
  const existentes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: BigInt(100 + i), numero_cuota: BigInt(i + 1) }));

  it('mismo número de cuotas → UPDATE por (compra, numero_cuota); NO borra ni recrea (Trigger 8 sincroniza)', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.cuotasDetalle.findMany.mockResolvedValue(existentes(10));
    prisma.cuotasDetalle.updateMany.mockResolvedValue({ count: 1 });
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    await service.recalcularCuotas(1, OWNER);

    expect(prisma.cuotasDetalle.updateMany).toHaveBeenCalledTimes(10);
    expect(prisma.cuotasDetalle.updateMany.mock.calls[2][0].where).toEqual({ compra: 1n, numero_cuota: 3n });
    expect(prisma.cuotasDetalle.deleteMany).not.toHaveBeenCalled();
    expect(prisma.cuotasDetalle.createMany).not.toHaveBeenCalled();
    expect(prisma.movimientosDeudaPersona.deleteMany).not.toHaveBeenCalled();

    // Solo se alinean fecha/periodo de los asientos existentes; NO se "toca" ResponsablesComprasCredito.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlDe(prisma.$executeRaw);
    expect(sql).toContain('UPDATE "MovimientosDeudaPersona"');
    expect(sql).not.toContain('ResponsablesComprasCredito');
  });

  it('cambia numero_cuotas → borra asientos, borra/recrea cuotas y re-dispara el Trigger 6, en ese orden', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.cuotasDetalle.findMany.mockResolvedValue(existentes(6)); // antes 6, ahora 10
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    await service.recalcularCuotas(1, OWNER);

    expect(prisma.movimientosDeudaPersona.deleteMany).toHaveBeenCalledWith({
      where: { cuota_detalle_id: { in: [100n, 101n, 102n, 103n, 104n, 105n] } },
    });
    expect(prisma.cuotasDetalle.updateMany).not.toHaveBeenCalled();
    expect(prisma.cuotasDetalle.createMany.mock.calls[0][0].data).toHaveLength(10);

    const orden = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(orden(prisma.movimientosDeudaPersona.deleteMany)).toBeLessThan(orden(prisma.cuotasDetalle.deleteMany));
    expect(orden(prisma.cuotasDetalle.deleteMany)).toBeLessThan(orden(prisma.cuotasDetalle.createMany));
    expect(orden(prisma.cuotasDetalle.createMany)).toBeLessThan(orden(prisma.$executeRaw));

    const sql = sqlDe(prisma.$executeRaw);
    expect(sql).toContain('UPDATE "ResponsablesComprasCredito"');
    expect(sql).toContain('SET porcentaje_pago = porcentaje_pago');
  });

  it('nunca escribe saldo_actual ni inserta asientos manualmente', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.cuotasDetalle.findMany.mockResolvedValue(existentes(3));
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });
    await service.recalcularCuotas(1, OWNER);

    expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();
    expect(prisma.movimientosDeudaPersona.createMany).not.toHaveBeenCalled();
    expect(prisma.cuentasFinancieras.update).not.toHaveBeenCalled();
    expect(prisma.cuentasFinancieras.updateMany).not.toHaveBeenCalled();
  });
});

describe('ComprasCreditoService.save', () => {
  const input = {
    concepto: 'Nevera',
    valorCompra: 1000,
    fechaCompra: '2024-01-10',
    numeroCuotas: 10,
    interes: 5,
    descripcion: 'Éxito',
    estado: 'Pendiente',
    tarjeta: 3,
  };

  function mockCreate(prisma: any) {
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 3n, dia_corte: null });
    prisma.comprasCredito.create.mockResolvedValue({ id: 55n });
  }

  it('COP por defecto: guarda cabecera + 10 cuotas con interés diferido y periodo_facturacion', async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);

    const id = await service.save(input, OWNER);

    expect(id).toBe(55);
    const { data } = prisma.comprasCredito.create.mock.calls[0][0];
    expect(data).toMatchObject({
      owner_user_id: OWNER,
      tarjeta: 3n,
      moneda_original: 'COP',
      trm_confirmada: true,
      numero_cuotas: 10,
    });
    expect(data.valor_compra.toString()).toBe('1000');
    expect(data.valor_moneda_original.toString()).toBe('1000');
    expect(data.tasa_cambio_aplicada.toString()).toBe('1');
    expect(data.pago_mensual.toString()).toBe('105'); // 100 + 5 % de 100
    expect(data.fecha_ultima_cuota.toISOString()).toBe('2024-10-31T00:00:00.000Z');

    const cuotas = prisma.cuotasDetalle.createMany.mock.calls[0][0].data;
    expect(cuotas).toHaveLength(10);
    expect(cuotas.every((c: any) => c.compra === 55n)).toBe(true);
    expect(cuotas[0].interes_pagado.toString()).toBe('0'); // cobraInteresPrimeraCuota = false
    expect(cuotas[1].interes_pagado.toString()).toBe('95');
    expect(cuotas[0].periodo_facturacion).toBe('2024-01');
  });

  it('una tarjeta de débito no admite compras a crédito (400) y no se guarda nada', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 3n, dia_corte: null, tipo_tarjeta: 'DEBITO' });
    await expect(service.save(input, OWNER)).rejects.toMatchObject({ status: 400 });
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
    expect(prisma.cuotasDetalle.createMany).not.toHaveBeenCalled();
  });

  it('no inserta responsables ni asientos del sub-ledger (los crea el endpoint de responsables + Trigger 6)', async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);
    await service.save(input, OWNER);
    expect(prisma.responsablesComprasCredito.create).not.toHaveBeenCalled();
    expect(prisma.movimientosDeudaPersona.createMany).not.toHaveBeenCalled();
  });

  it('USD: valor_compra = valor_moneda_original × TRM (2 decimales) y trm_confirmada = false', async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);

    await service.save(
      { ...input, valorCompra: undefined, interes: 0, numeroCuotas: 3, monedaOriginal: 'USD', valorMonedaOriginal: 100, tasaCambioAplicada: 4200 },
      OWNER,
    );

    const { data } = prisma.comprasCredito.create.mock.calls[0][0];
    expect(data.moneda_original).toBe('USD');
    expect(data.valor_compra.toString()).toBe('420000');
    expect(data.valor_moneda_original.toString()).toBe('100');
    expect(data.tasa_cambio_aplicada.toString()).toBe('4200');
    expect(data.trm_confirmada).toBe(false);
    const cuotas = prisma.cuotasDetalle.createMany.mock.calls[0][0].data;
    expect(cuotas.map((c: any) => c.pago_total.toString())).toEqual(['140000', '140000', '140000']);
  });

  it('USD con decimales de TRM: 49.99 × 4150.1234 = 207464.67', async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);
    await service.save(
      { ...input, valorCompra: undefined, interes: 0, numeroCuotas: 1, monedaOriginal: 'usd', valorMonedaOriginal: 49.99, tasaCambioAplicada: 4150.1234 },
      OWNER,
    );
    expect(prisma.comprasCredito.create.mock.calls[0][0].data.valor_compra.toString()).toBe('207464.67');
  });

  it('divisa extranjera sin TRM → 400 "Datos inválidos"', async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);
    await expect(
      service.save({ ...input, valorCompra: undefined, monedaOriginal: 'USD', valorMonedaOriginal: 10 }, OWNER),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
  });

  it("acepta fechas ISO con hora como el legacy (SimpleDateFormat ignora el sufijo)", async () => {
    const { prisma, service } = setup();
    mockCreate(prisma);
    await service.save({ ...input, fechaCompra: '2024-01-10T15:30:00.000Z' }, OWNER);
    expect(prisma.comprasCredito.create.mock.calls[0][0].data.fecha_compra.toISOString()).toBe('2024-01-10T00:00:00.000Z');
  });

  it('usa Tarjetas.dia_corte para fechar la primera cuota', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 3n, dia_corte: 10 });
    prisma.comprasCredito.create.mockResolvedValue({ id: 1n });
    await service.save({ ...input, fechaCompra: '2024-03-12', numeroCuotas: 2, interes: 0 }, OWNER); // 12 > 10 → mes siguiente
    const cuotas = prisma.cuotasDetalle.createMany.mock.calls[0][0].data;
    expect(cuotas[0].fecha_pago.toISOString()).toBe('2024-04-30T00:00:00.000Z');
  });

  it('rechaza una tarjeta que no pertenece al usuario', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(null);
    await expect(service.save(input, OWNER)).rejects.toThrow('No se encontró la tarjeta');
    expect(prisma.tarjetas.findFirst.mock.calls[0][0].where).toEqual({ id: 3n, owner_user_id: OWNER });
    expect(prisma.comprasCredito.create).not.toHaveBeenCalled();
  });

  it('valida cuotas, fecha y valor', async () => {
    const { service } = setup();
    await expect(service.save({ ...input, numeroCuotas: 0 }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(service.save({ ...input, fechaCompra: '05/04/2024' }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(service.save({ ...input, valorCompra: -5 }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(service.save({ ...input, valorCompra: undefined }, OWNER)).rejects.toMatchObject({ status: 400 });
  });
});

describe('ComprasCreditoService.updateCompra', () => {
  it('actualiza la cabecera, recalcula y corrige pago_mensual (el legacy lo dejaba = valor total)', async () => {
    const { prisma, service } = setup();
    const existente = compraBase();
    prisma.comprasCredito.findFirst.mockResolvedValue(existente);
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 2n });
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.comprasCredito.update.mockResolvedValue({ ...existente, valor_compra: dec('1200'), numero_cuotas: 12, interes: dec('2.5') });
    prisma.cuotasDetalle.findMany.mockResolvedValue([]);
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.updateCompra(
      1,
      { concepto: 'Compra', valorCompra: 1200, fechaCompra: '2024-01-10', numeroCuotas: 12, interes: 2.5, descripcion: 'd', estado: 'Pendiente', tarjeta: 2 },
      OWNER,
    );

    expect(result).toBe(1);
    expect(prisma.comprasCredito.update.mock.calls[0][0].data.tarjeta).toBe(2n);
    expect(prisma.comprasCredito.updateMany.mock.calls[0][0].data.pago_mensual.toString()).toBe('102.5');
  });

  it('una compra en USD editada con el contrato legacy (sin monedaOriginal) conserva divisa y TRM', async () => {
    const { prisma, service } = setup();
    const existente = compraBase({
      moneda_original: 'USD',
      valor_compra: dec('420000'),
      valor_moneda_original: dec('100'),
      tasa_cambio_aplicada: dec('4200'),
      trm_confirmada: false,
    });
    prisma.comprasCredito.findFirst.mockResolvedValue(existente);
    prisma.tarjetas.findFirst.mockResolvedValue({ id: 3n });
    prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
    prisma.comprasCredito.update.mockResolvedValue(existente);
    prisma.cuotasDetalle.findMany.mockResolvedValue([]);
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });

    await service.updateCompra(
      1,
      { concepto: 'Compra', valorCompra: 420000, fechaCompra: '2024-01-10', numeroCuotas: 10, interes: 0, descripcion: 'd', estado: 'Pendiente', tarjeta: 3 },
      OWNER,
    );
    const { data } = prisma.comprasCredito.update.mock.calls[0][0];
    expect(data.moneda_original).toBe('USD');
    expect(data.tasa_cambio_aplicada.toString()).toBe('4200');
    expect(data.valor_moneda_original.toString()).toBe('100');
    expect(data.trm_confirmada).toBe(false);
  });
});

describe('ComprasCreditoService.ajusteInteresTarjetaCredito', () => {
  it("marca la compra 'Ajuste Interes', cobra interés en la cuota 1 y las cuotas con fecha >= hoy quedan 'Ajuste Interes'", async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue({ dia_corte: null });
    prisma.comprasCredito.findMany.mockResolvedValue([compraBase()]);
    prisma.cuotasDetalle.findMany.mockResolvedValue([]);

    await service.ajusteInteresTarjetaCredito(1234, OWNER, HOY);

    expect(prisma.comprasCredito.findMany.mock.calls[0][0].where).toMatchObject({
      tarjeta: 1234n,
      owner_user_id: OWNER,
      estado: { equals: 'PENDIENTE', mode: 'insensitive' },
    });
    expect(prisma.comprasCredito.update).toHaveBeenCalledWith({ where: { id: 1n }, data: { estado: 'Ajuste Interes' } });
    const cuotas = prisma.cuotasDetalle.createMany.mock.calls[0][0].data;
    expect(cuotas[0].interes_pagado.toString()).toBe('50');
    // 2024-01..05 anteriores a hoy (2024-06-15) → 'Pagado'; desde 2024-06-30 → 'Ajuste Interes'
    expect(cuotas.map((c: any) => c.estado)).toEqual([
      'Pagado', 'Pagado', 'Pagado', 'Pagado', 'Pagado',
      'Ajuste Interes', 'Ajuste Interes', 'Ajuste Interes', 'Ajuste Interes', 'Ajuste Interes',
    ]);
  });
});

describe('ComprasCreditoService.delete', () => {
  it('cascada: MovimientosDeudaPersona → Responsables → Cuotas → Compra, todo en una transacción', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    prisma.cuotasDetalle.findMany.mockResolvedValue([{ id: 10n }, { id: 11n }]);
    prisma.responsablesComprasCredito.findMany.mockResolvedValue([{ id: 5n }]);

    await service.delete(1, OWNER);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.movimientosDeudaPersona.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ cuota_detalle_id: { in: [10n, 11n] } }, { responsable_compra_id: { in: [5n] } }] },
    });
    const orden = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(orden(prisma.movimientosDeudaPersona.deleteMany)).toBeLessThan(orden(prisma.responsablesComprasCredito.deleteMany));
    expect(orden(prisma.responsablesComprasCredito.deleteMany)).toBeLessThan(orden(prisma.cuotasDetalle.deleteMany));
    expect(orden(prisma.cuotasDetalle.deleteMany)).toBeLessThan(orden(prisma.comprasCredito.delete));
    expect(prisma.comprasCredito.delete).toHaveBeenCalledWith({ where: { id: 1n } });
  });

  it('compra inexistente (o de otro usuario) → error y no borra nada', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(null);
    await expect(service.delete(99999, OWNER)).rejects.toThrow('No se encontró la compra con ID 99999');
    expect(prisma.comprasCredito.delete).not.toHaveBeenCalled();
    expect(prisma.cuotasDetalle.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ComprasCreditoService.cambioEstado', () => {
  it("pasa a 'Pagado' las compras Pendiente/Activa con última cuota anterior a hoy", async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.updateMany.mockResolvedValue({ count: 3 });
    const n = await service.cambioEstado(OWNER, HOY);
    expect(n).toBe(3);
    const args = prisma.comprasCredito.updateMany.mock.calls[0][0];
    expect(args.where.owner_user_id).toBe(OWNER);
    expect(args.where.fecha_ultima_cuota).toEqual({ lt: HOY });
    expect(args.where.OR).toEqual([
      { estado: { equals: 'PENDIENTE', mode: 'insensitive' } },
      { estado: { equals: 'ACTIVA', mode: 'insensitive' } },
    ]);
    expect(args.data).toEqual({ estado: 'Pagado' });
  });
});

describe('ComprasCreditoService.confirmarTrm (SP sp_actualizar_trm_compra_usd)', () => {
  it('invoca el SP con la TRM a 4 decimales y no recalcula nada en TypeScript', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase({ moneda_original: 'USD', trm_confirmada: false }));

    await service.confirmarTrm(1, OWNER, 4150.12345, true).catch(() => undefined); // getById final devuelve null con el mock

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...params] = prisma.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('sp_actualizar_trm_compra_usd(');
    expect(params[0]).toBe(1n);
    expect(String(params[1])).toBe('4150.1235');
    expect(params[2]).toBe(true);
    expect(prisma.cuotasDetalle.updateMany).not.toHaveBeenCalled();
  });

  it('rechaza compras en COP y TRM inválida', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue(compraBase());
    await expect(service.confirmarTrm(1, OWNER, 4150)).rejects.toMatchObject({ status: 400 });
    await expect(service.confirmarTrm(1, OWNER, 0)).rejects.toMatchObject({ status: 400 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
