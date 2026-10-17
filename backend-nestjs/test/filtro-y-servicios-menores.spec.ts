/* eslint-disable @typescript-eslint/no-explicit-any */
import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ConsultasPagosService } from '../src/modules/consultas-pagos/consultas-pagos.service';
import { CuentasFinancierasService } from '../src/modules/cuentas-financieras/cuentas-financieras.service';
import { PagosService } from '../src/modules/compras-credito/pagos.service';
import { PersonasService } from '../src/modules/personas/personas.service';
import { ResponsablesService } from '../src/modules/compras-credito/responsables.service';
import { createPrismaMock, dec, sqlDe, utc } from './helpers/prisma-mock';

const OWNER = 7n;

describe('AllExceptionsFilter', () => {
  const filtro = new AllExceptionsFilter();
  function ejecutar(excepcion: unknown) {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    filtro.catch(excepcion, host);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  }
  const prismaError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });

  it('HttpException con cuerpo legacy se devuelve tal cual', () => {
    expect(ejecutar(new HttpException({ status: 'error', message: 'Invalid email or password' }, 401))).toEqual({
      status: 401,
      body: { status: 'error', message: 'Invalid email or password' },
    });
    expect(ejecutar(new HttpException({ mensaje: 'x' }, 404)).body).toEqual({ mensaje: 'x' });
  });

  it('excepciones estándar de Nest conservan su forma', () => {
    expect(ejecutar(new NotFoundException('nada'))).toEqual({ status: 404, body: { message: 'nada', error: 'Not Found', statusCode: 404 } });
    expect(ejecutar(new BadRequestException('mal')).status).toBe(400);
  });

  it.each([
    ['P2002', 409, 'Registro duplicado (email)'],
    ['P2003', 409, 'Violación de llave foránea'],
    ['P2025', 404, 'Registro no encontrado'],
    ['P2000', 400, 'Datos inválidos'],
    ['P2010', 500, 'Error de base de datos (P2010)'],
  ])('error Prisma %s → %s', (codigo, status, mensaje) => {
    const r = ejecutar(prismaError(codigo, { target: ['email'] }));
    expect(r.status).toBe(status);
    expect(r.body.message).toContain(mensaje);
  });

  it('validación de Prisma → 400; cualquier otro error → 500 sin filtrar detalles internos', () => {
    expect(ejecutar(new Prisma.PrismaClientValidationError('x', { clientVersion: 'test' })).status).toBe(400);
    const r = ejecutar(new Error('SELECT * FROM secreto'));
    expect(r).toEqual({ status: 500, body: { message: 'Error interno del servidor' } });
  });

  it('serializa BigInt/Decimal dentro del cuerpo de error (nunca TypeError)', () => {
    const r = ejecutar(new HttpException({ message: 'x', id: 5n, monto: dec('1.5') }, 400));
    expect(r.body).toEqual({ message: 'x', id: 5, monto: 1.5 });
  });
});

describe('CuentasFinancierasService', () => {
  function setup() {
    const prisma = createPrismaMock();
    return { prisma, service: new CuentasFinancierasService(prisma) };
  }

  it('create: saldo inicial con Decimal, moneda en mayúsculas', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.create.mockImplementation(async ({ data }: any) => data);
    const r: any = await service.create({ nombre: 'Nu', tipoCuenta: 'AHORROS' as any, moneda: 'usd', saldoInicial: 10.1, ultimos4Digitos: '4321' }, OWNER);
    expect(r).toMatchObject({ owner_user_id: OWNER, nombre: 'Nu', moneda: 'USD', ultimos_4_digitos: '4321', is_active: true });
    expect(r.saldo_actual.toString()).toBe('10.1');
  });

  it('update jamás envía saldo_actual', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    prisma.cuentasFinancieras.update.mockImplementation(async ({ data }: any) => data);
    const data = await service.update(3, { nombre: 'Nuevo', isActive: false, bancoEntidad: 'X', tipoCuenta: 'CORRIENTE' as any, ultimos4Digitos: '1111' }, OWNER);
    expect(Object.keys(data)).toEqual(['nombre', 'tipo_cuenta', 'banco_entidad', 'ultimos_4_digitos', 'is_active']);
  });

  it('remove: con movimientos → 409; sin movimientos → elimina; ajena → 404', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
    prisma.transacciones.count.mockResolvedValue(2);
    await expect(service.remove(3, OWNER)).rejects.toMatchObject({ status: 409 });
    prisma.transacciones.count.mockResolvedValue(0);
    await service.remove(3, OWNER);
    expect(prisma.cuentasFinancieras.delete).toHaveBeenCalledWith({ where: { id: 3n } });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue(null);
    await expect(service.get(99, OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it('categorías: filtro sistema+propias, tipo AMBOS incluido, eliminar en uso → 409', async () => {
    const { prisma, service } = setup();
    await service.listCategorias(OWNER, 'EGRESO');
    const where = prisma.categorias.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ owner_user_id: null }, { owner_user_id: OWNER }]);
    expect(where.tipo).toEqual({ in: ['EGRESO', 'AMBOS'] });

    prisma.categorias.findFirst.mockResolvedValue({ id: 4n, owner_user_id: OWNER });
    prisma.transacciones.count.mockResolvedValue(1);
    await expect(service.removeCategoria(4, OWNER)).rejects.toMatchObject({ status: 409 });
    prisma.categorias.findFirst.mockResolvedValue({ id: 1n, owner_user_id: null });
    await expect(service.removeCategoria(1, OWNER)).rejects.toMatchObject({ status: 403 });
  });
});

describe('ResponsablesService', () => {
  function setup() {
    const prisma = createPrismaMock();
    return { prisma, service: new ResponsablesService(prisma) };
  }

  it('listByCompra: solo responsables de compras del usuario, JSON legacy', async () => {
    const { prisma, service } = setup();
    prisma.responsablesComprasCredito.findMany.mockResolvedValue([
      { id: 1n, created_at: new Date('2024-05-01T10:00:00Z'), persona: 2n, porcentaje_pago: dec('33.3333'), cantidad_pago: dec('42500.5'), cantidad_cuotas: 36, compra_credito: 9n },
    ]);
    expect(await service.listByCompra(9, OWNER)).toEqual([
      { id: 1, fechaCreacion: 1714521600000, persona: 2, porcentajePago: 33.3333, cantidadPago: 42500.5, cantidadCuotas: 36, compraCredito: 9 },
    ]);
    expect(prisma.responsablesComprasCredito.findMany.mock.calls[0][0].where).toEqual({ compra_credito: 9n, compra_credito_ref: { owner_user_id: OWNER } });
  });

  it('create valida compra y persona del usuario, guarda con Decimal y no toca el sub-ledger', async () => {
    const { prisma, service } = setup();
    prisma.comprasCredito.findFirst.mockResolvedValue({ id: 9n });
    prisma.personas.findFirst.mockResolvedValue({ id: 2n });
    prisma.responsablesComprasCredito.create.mockResolvedValue({ id: 14n });
    const id = await service.create({ persona: 2, porcentajePago: 33.3333, cantidadPago: 42500.5, cantidadCuotas: 36, compraCredito: 9 }, OWNER);
    expect(id).toBe(14);
    const { data } = prisma.responsablesComprasCredito.create.mock.calls[0][0];
    expect(data.porcentaje_pago.toString()).toBe('33.3333');
    expect(data.cantidad_pago.toString()).toBe('42500.5');
    expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();

    prisma.comprasCredito.findFirst.mockResolvedValue(null);
    await expect(service.create({ persona: 2, porcentajePago: 1, cantidadPago: 1, cantidadCuotas: 1, compraCredito: 9 }, OWNER)).rejects.toThrow('No se encontró la compra');
  });

  it('update: limpia asientos de cuotas sobrantes antes de actualizar; persona ajena rechazada', async () => {
    const { prisma, service } = setup();
    prisma.responsablesComprasCredito.findFirst.mockResolvedValue({ id: 14n });
    prisma.personas.findFirst.mockResolvedValue({ id: 2n });
    prisma.responsablesComprasCredito.update.mockResolvedValue({});
    await service.update({ id: 14, persona: 2, porcentajePago: 25, cantidadPago: 1, cantidadCuotas: 4, compraCredito: 9 }, OWNER);
    const sql = sqlDe(prisma.$executeRaw);
    expect(sql).toContain('DELETE FROM "MovimientosDeudaPersona"');
    expect(sql).toContain('cd.numero_cuota >');
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.responsablesComprasCredito.update.mock.invocationCallOrder[0]);

    prisma.personas.findFirst.mockResolvedValue(null);
    await expect(service.update({ id: 14, persona: 9, porcentajePago: 25, cantidadPago: 1, cantidadCuotas: 4, compraCredito: 9 }, OWNER)).rejects.toThrow('No se encontró la persona');
  });

  it('delete: borra primero los asientos del responsable; inexistente → error legacy', async () => {
    const { prisma, service } = setup();
    prisma.responsablesComprasCredito.findFirst.mockResolvedValue({ id: 14n });
    await service.delete(14, OWNER);
    expect(prisma.movimientosDeudaPersona.deleteMany).toHaveBeenCalledWith({ where: { responsable_compra_id: 14n } });
    expect(prisma.movimientosDeudaPersona.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.responsablesComprasCredito.delete.mock.invocationCallOrder[0]);
    prisma.responsablesComprasCredito.findFirst.mockResolvedValue(null);
    await expect(service.delete(99, OWNER)).rejects.toThrow('No se encontró el responsable con ID 99');
  });
});

describe('Consultas de pagos, personas y pagos de tarjeta (SQL y formato)', () => {
  it('PagosService.calcularPagoTarjetaCreditoDetalle mapea CuotaDetalleMes', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      { id: 5n, concepto: 'Nevera', numero_cuota: 3n, numero_cuotas: 12, fecha_pago: utc('2024-04-30'), saldo_restante: dec('900'), interes_pagado: dec('10.5'), aporte_capital: dec('100'), pago_total: dec('110.5'), compra: 2n, estado: 'Pendiente', tarjeta: 1n },
    ]);
    const [fila] = await new PagosService(prisma).calcularPagoTarjetaCreditoDetalle(1, 2024, 4, OWNER);
    expect(fila).toEqual({ id: 5, numeroCuota: 3, fechaPago: 1714435200000, saldoRestante: 900, interesPagado: 10.5, aporteCapital: 100, pagoTotal: 110.5, compra: 2, estado: 'Pendiente', tarjeta: 1, concepto: 'Nevera', numeroCuotasTotal: 12 });
    const sql = sqlDe(prisma.$queryRaw);
    expect(sql).toContain("cd.estado NOT IN ('Ajuste Interes', 'REFINANCIADA')");
    expect(sql).toContain("DATE_TRUNC('month', cd.fecha_pago)");
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([2024, 4, 1n, OWNER]);
  });

  it('ConsultasPagosService: filtra por dueño y excluye conceptos de ajuste', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([]);
    const servicio = new ConsultasPagosService(prisma);
    await servicio.listPagosMensualesPersona(OWNER);
    expect(sqlDe(prisma.$queryRaw, 0)).toContain('cc.owner_user_id =');
    await servicio.listPagosMensualesPersonaDetalle(2, 4, 2024, OWNER);
    expect(sqlDe(prisma.$queryRaw, 1)).toContain("cc.concepto NOT LIKE '%Ajuste de Interes%'");
    expect(prisma.$queryRaw.mock.calls[1].slice(1)).toEqual([2n, OWNER, 2024, 4]);
  });

  it('PersonasService: lista del usuario y verifica pertenencia', async () => {
    const prisma = createPrismaMock();
    const servicio = new PersonasService(prisma);
    await servicio.listLegacy(OWNER);
    expect(prisma.personas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: OWNER });
    await expect(servicio.assertOwned(5n, OWNER)).rejects.toThrow('No se encontró la persona con ID 5');
    prisma.personas.findFirst.mockResolvedValue({ id: 5n });
    await expect(servicio.assertOwned(5n, OWNER)).resolves.toBeUndefined();
  });
});
