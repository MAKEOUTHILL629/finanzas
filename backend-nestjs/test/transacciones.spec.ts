/* eslint-disable @typescript-eslint/no-explicit-any */
import { TipoTransaccion as T } from '../src/common/enums/finance.enums';
import { validarReglasTransaccion } from '../src/modules/transacciones/transaccion.rules';
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 7n;

describe('validarReglasTransaccion (reglas de negocio del libro diario)', () => {
  it.each([T.EGRESO, T.PAGO_PRESTAMO])('%s exige cuenta de origen y rechaza destino', (tipo) => {
    expect(validarReglasTransaccion({ tipoTransaccion: tipo, cuentaOrigenId: 1 })).toEqual([]);
    expect(validarReglasTransaccion({ tipoTransaccion: tipo })).toEqual([`cuentaOrigenId es obligatoria para ${tipo}`]);
    expect(validarReglasTransaccion({ tipoTransaccion: tipo, cuentaOrigenId: 1, cuentaDestinoId: 2 })).toEqual([
      `cuentaDestinoId no aplica para ${tipo}`,
    ]);
  });

  it.each([T.INGRESO, T.REEMBOLSO_TERCERO])('%s exige cuenta destino y rechaza origen', (tipo) => {
    expect(validarReglasTransaccion({ tipoTransaccion: tipo, cuentaDestinoId: 2 })).toEqual([]);
    expect(validarReglasTransaccion({ tipoTransaccion: tipo })).toEqual([`cuentaDestinoId es obligatoria para ${tipo}`]);
    expect(validarReglasTransaccion({ tipoTransaccion: tipo, cuentaOrigenId: 1, cuentaDestinoId: 2 })).toEqual([
      `cuentaOrigenId no aplica para ${tipo}`,
    ]);
  });

  it('PAGO_TARJETA exige origen y tarjeta pagada', () => {
    expect(validarReglasTransaccion({ tipoTransaccion: T.PAGO_TARJETA, cuentaOrigenId: 1, tarjetaPagadaId: 3 })).toEqual([]);
    expect(validarReglasTransaccion({ tipoTransaccion: T.PAGO_TARJETA, cuentaOrigenId: 1 })).toEqual([
      'tarjetaPagadaId es obligatoria para PAGO_TARJETA',
    ]);
  });

  it('TRANSFERENCIA exige ambas cuentas y distintas (una fila actualiza las dos)', () => {
    expect(validarReglasTransaccion({ tipoTransaccion: T.TRANSFERENCIA, cuentaOrigenId: 1, cuentaDestinoId: 2 })).toEqual([]);
    expect(validarReglasTransaccion({ tipoTransaccion: T.TRANSFERENCIA, cuentaOrigenId: 1 })).toEqual([
      'cuentaDestinoId es obligatoria para TRANSFERENCIA',
    ]);
    expect(validarReglasTransaccion({ tipoTransaccion: T.TRANSFERENCIA, cuentaOrigenId: 5, cuentaDestinoId: 5 })).toEqual([
      'cuentaOrigenId y cuentaDestinoId deben ser distintas en una TRANSFERENCIA',
    ]);
    expect(validarReglasTransaccion({ tipoTransaccion: T.TRANSFERENCIA, cuentaOrigenId: 5n, cuentaDestinoId: 5 })).toHaveLength(1);
  });
});

describe('TransaccionesService', () => {
  function setup() {
    const prisma = createPrismaMock();
    prisma.cuentasFinancieras.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id, owner_user_id: OWNER }));
    prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 500n, ...data }));
    return { prisma, service: new TransaccionesService(prisma) };
  }

  it('EGRESO manual: CONFIRMADO por defecto, monto COP con Decimal, NUNCA toca saldo_actual', async () => {
    const { prisma, service } = setup();
    await service.create(
      { tipoTransaccion: T.EGRESO, cuentaOrigenId: 3, concepto: 'Mercado', montoOriginal: 150000.5 },
      OWNER,
    );
    const { data } = prisma.transacciones.create.mock.calls[0][0];
    expect(data).toMatchObject({
      owner_user_id: OWNER,
      tipo_transaccion: 'EGRESO',
      cuenta_origen_id: 3n,
      cuenta_destino_id: null,
      moneda_original: 'COP',
      origen_registro: 'MANUAL',
      estado: 'CONFIRMADO',
    });
    expect(data.monto_original.toString()).toBe('150000.5');
    expect(data.monto_cop.toString()).toBe('150000.5');
    expect(data.tasa_cambio.toString()).toBe('1');
    expect(prisma.cuentasFinancieras.update).not.toHaveBeenCalled();
    expect(prisma.cuentasFinancieras.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('origen EMAIL_AUTO → PENDIENTE_REVISION por defecto', async () => {
    const { prisma, service } = setup();
    await service.create(
      { tipoTransaccion: T.INGRESO, cuentaDestinoId: 3, concepto: 'Nómina', montoOriginal: 100, origenRegistro: 'EMAIL_AUTO' as any },
      OWNER,
    );
    expect(prisma.transacciones.create.mock.calls[0][0].data.estado).toBe('PENDIENTE_REVISION');
  });

  it('TRANSFERENCIA = una sola fila con ambas cuentas', async () => {
    const { prisma, service } = setup();
    await service.create(
      { tipoTransaccion: T.TRANSFERENCIA, cuentaOrigenId: 1, cuentaDestinoId: 2, concepto: 'A Nequi', montoOriginal: 80000 },
      OWNER,
    );
    expect(prisma.transacciones.create).toHaveBeenCalledTimes(1);
    expect(prisma.transacciones.create.mock.calls[0][0].data).toMatchObject({ cuenta_origen_id: 1n, cuenta_destino_id: 2n });
  });

  it('divisa extranjera: monto_cop = monto × TRM (Decimal); sin TRM → 400', async () => {
    const { prisma, service } = setup();
    await service.create(
      { tipoTransaccion: T.EGRESO, cuentaOrigenId: 1, concepto: 'Netflix', monedaOriginal: 'usd', montoOriginal: 15.99, tasaCambio: 4150.1234 },
      OWNER,
    );
    const { data } = prisma.transacciones.create.mock.calls[0][0];
    expect(data.moneda_original).toBe('USD');
    expect(data.monto_cop.toString()).toBe('66360.47'); // 15.99 × 4150.1234 = 66360.473166 → HALF_UP 2 dec.
    expect(data.tasa_cambio.toString()).toBe('4150.1234');

    await expect(
      service.create({ tipoTransaccion: T.EGRESO, cuentaOrigenId: 1, concepto: 'x', monedaOriginal: 'USD', montoOriginal: 5 }, OWNER),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rechaza combinaciones inválidas antes de tocar la BD', async () => {
    const { prisma, service } = setup();
    await expect(
      service.create({ tipoTransaccion: T.INGRESO, cuentaOrigenId: 1, cuentaDestinoId: 2, concepto: 'x', montoOriginal: 5 }, OWNER),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.transacciones.create).not.toHaveBeenCalled();
  });

  it('cuenta ajena → 404 (multi-tenant)', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue(null);
    await expect(
      service.create({ tipoTransaccion: T.EGRESO, cuentaOrigenId: 99, concepto: 'x', montoOriginal: 5 }, OWNER),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.cuentasFinancieras.findFirst.mock.calls[0][0].where).toEqual({ id: 99n, owner_user_id: OWNER });
  });

  it('PATCH revalida el resultado fusionado', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findFirst.mockResolvedValue({
      id: 10n,
      tipo_transaccion: 'INGRESO',
      cuenta_origen_id: null,
      cuenta_destino_id: 2n,
      tarjeta_pagada_id: null,
      categoria_id: null,
      fecha_transaccion: new Date('2026-10-01T00:00:00Z'),
      concepto: 'Nómina',
      moneda_original: 'COP',
      monto_original: dec('100'),
      tasa_cambio: dec('1'),
      monto_cop: dec('100'),
      origen_registro: 'MANUAL',
      estado: 'CONFIRMADO',
      notas: null,
    });
    prisma.transacciones.update.mockImplementation(async ({ data }: any) => data);

    // Agregar una cuenta de origen a un INGRESO afectaría otro saldo vía Trigger 2 → se rechaza
    await expect(service.update(10, { cuentaOrigenId: 5 }, OWNER)).rejects.toMatchObject({ status: 400 });

    await service.update(10, { montoOriginal: 250 }, OWNER);
    const data = prisma.transacciones.update.mock.calls[0][0].data;
    expect(data.monto_original.toString()).toBe('250');
    expect(data.monto_cop.toString()).toBe('250'); // se recalcula al cambiar el monto
  });

  it('DELETE = anular (el Trigger 2 revierte el saldo; se conserva la auditoría)', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findFirst.mockResolvedValue({ id: 10n });
    prisma.transacciones.update.mockResolvedValue({ id: 10n, estado: 'ANULADO' });
    await service.anular(10, OWNER);
    expect(prisma.transacciones.update).toHaveBeenCalledWith({ where: { id: 10n }, data: { estado: 'ANULADO' } });
    expect(prisma.transacciones.delete).not.toHaveBeenCalled();
  });

  it('list aplica filtros y siempre el owner', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.count.mockResolvedValue(3);
    const r = await service.list(OWNER, { desde: '2026-10-01', hasta: '2026-10-31', cuentaId: 4, tipo: T.EGRESO, limit: 20, offset: 40 });
    const args = prisma.transacciones.findMany.mock.calls[0][0];
    expect(args.where.owner_user_id).toBe(OWNER);
    expect(args.where.OR).toEqual([{ cuenta_origen_id: 4n }, { cuenta_destino_id: 4n }]);
    expect(args.where.fecha_transaccion.lte.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    expect(args.take).toBe(20);
    expect(args.skip).toBe(40);
    expect(r.total).toBe(3);
  });
});


describe('TransaccionesService — Fase 1 (Iteración 3): Tags y Comercio Canónico', () => {
  it('create y update normalizan tags y sincronizan catálogo de Etiquetas', async () => {
    const prisma = createPrismaMock();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 1n, owner_user_id: OWNER });
    prisma.transacciones.create.mockImplementation(async ({ data }: any) => ({ id: 700n, ...data }));
    const service = new TransaccionesService(prisma);

    await service.create(
      {
        tipoTransaccion: T.EGRESO,
        cuentaOrigenId: 1,
        concepto: 'Pedido Rappi',
        montoOriginal: 32000,
        tags: ['Rappi', '#domicilios'],
        comercioCanonico: 'Rappi',
      },
      OWNER,
    );

    const createdData = prisma.transacciones.create.mock.calls[0][0].data;
    expect(createdData.tags).toEqual(['#rappi', '#domicilios']);
    expect(createdData.comercio_canonico).toBe('Rappi');
    expect(prisma.etiquetas.upsert).toHaveBeenCalledTimes(2);
  });
});
