/* eslint-disable @typescript-eslint/no-explicit-any */
import { CortesCobroService } from '../src/modules/prestamos/cortes-cobro.service';
import { PrestamosService } from '../src/modules/prestamos/prestamos.service';
import { createPrismaMock, dec, utc } from './helpers/prisma-mock';

const OWNER = 7n;

function setup() {
  const prisma = createPrismaMock();
  const prestamos = new PrestamosService(prisma);
  const cortes = new CortesCobroService(prisma, prestamos);
  return { prisma, prestamos, cortes };
}

const dtoLegacy = {
  valorPrestado: 500000,
  concepto: 'Préstamo para viaje',
  fechaCobro: '2024-06-01',
  responsable: 2,
  estado: 'Pendiente',
  comentarios: '',
};

describe('PrestamosService.create (POST /api/prestamos)', () => {
  it('guarda con owner, saldo_pendiente = valor, corte activo y SIN tocar el sub-ledger (Trigger 4)', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => (where.id ? { id: where.id } : { id: 1n }));
    prisma.cortesCobro.findFirst.mockResolvedValue({ id: 12n });
    prisma.prestamos.create.mockResolvedValue({ id: 88n });

    const id = await prestamos.create(dtoLegacy, OWNER);

    expect(id).toBe(88);
    const { data } = prisma.prestamos.create.mock.calls[0][0];
    expect(data).toMatchObject({
      owner_user_id: OWNER,
      responsable: 2n,
      estado: 'Pendiente',
      direccion_prestamo: 'POR_COBRAR',
      corte_id: 12n,
      creado_por_persona_id: 1n,
    });
    expect(data.valor_prestado.toString()).toBe('500000');
    expect(data.saldo_pendiente.toString()).toBe('500000');
    expect(data.fecha_cobro.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(prisma.movimientosDeudaPersona.create).not.toHaveBeenCalled();
    expect(prisma.movimientosDeudaPersona.createMany).not.toHaveBeenCalled();
  });

  it('la persona responsable debe ser del usuario', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockResolvedValue(null);
    await expect(prestamos.create(dtoLegacy, OWNER)).rejects.toThrow('No se encontró la persona con ID 2');
    expect(prisma.prestamos.create).not.toHaveBeenCalled();
  });

  it('fechaCobro con sufijo horario se acepta (legacy)', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id ?? 1n }));
    prisma.prestamos.create.mockResolvedValue({ id: 1n });
    await prestamos.create({ ...dtoLegacy, fechaCobro: '2024-06-01T00:00:00.000Z' }, OWNER);
    expect(prisma.prestamos.create.mock.calls[0][0].data.fecha_cobro.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('valida valor y fecha', async () => {
    const { prestamos } = setup();
    await expect(prestamos.create({ ...dtoLegacy, valorPrestado: 0 }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(prestamos.create({ ...dtoLegacy, fechaCobro: '01/06/2024' }, OWNER)).rejects.toMatchObject({ status: 400 });
  });

  it('soporta direccion, método, fecha_prestamo y corte explícito (v2)', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id ?? 1n }));
    prisma.cortesCobro.findFirst.mockResolvedValue({ id: 40n });
    prisma.prestamos.create.mockResolvedValue({ id: 1n });
    await prestamos.create(
      { ...dtoLegacy, direccionPrestamo: 'POR_PAGAR' as any, metodo: 'Nequi' as any, fechaPrestamo: '2024-05-20', corteId: 40 },
      OWNER,
    );
    expect(prisma.prestamos.create.mock.calls[0][0].data).toMatchObject({
      direccion_prestamo: 'POR_PAGAR',
      metodo: 'Nequi',
      corte_id: 40n,
    });
    expect(prisma.prestamos.create.mock.calls[0][0].data.fecha_prestamo.toISOString()).toBe('2024-05-20T00:00:00.000Z');
  });

  it('Iteración 2 Fase 5: enlaza transaccionDesembolsoId existente, le asigna categoría Préstamos / Desembolsos y detecta notificacion_correo_id', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id ?? 1n }));
    prisma.cortesCobro.findFirst.mockResolvedValue({ id: 12n });
    prisma.transacciones.findFirst.mockResolvedValue({ id: 55n, owner_user_id: OWNER, cuenta_origen_id: 3n, categoria_id: null });
    prisma.categorias.findFirst.mockResolvedValue({ id: 91n });
    prisma.transacciones.update.mockResolvedValue({ id: 55n });
    prisma.notificacionesCorreo.findFirst.mockResolvedValue({ id: 777n });
    prisma.prestamos.create.mockResolvedValue({ id: 99n });

    const id = await prestamos.create(
      { ...dtoLegacy, transaccionDesembolsoId: 55 },
      OWNER,
    );

    expect(id).toBe(99);
    expect(prisma.transacciones.update).toHaveBeenCalledWith({
      where: { id: 55n },
      data: { categoria_id: 91n },
    });
    expect(prisma.prestamos.create.mock.calls[0][0].data).toMatchObject({
      transaccion_desembolso_id: 55n,
      notificacion_correo_id: 777n,
      cuenta_origen_desembolso_id: 3n,
    });
  });

  it('Iteración 2 Fase 5: crea transacción de desembolso automáticamente cuando cuentaOrigenDesembolsoId + crearTransaccionTransferencia = true', async () => {
    const { prisma, prestamos } = setup();
    prisma.personas.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id ?? 1n }));
    prisma.cortesCobro.findFirst.mockResolvedValue({ id: 12n });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 4n });
    prisma.categorias.findFirst.mockResolvedValue({ id: 91n });
    prisma.transacciones.create.mockResolvedValue({ id: 66n });
    prisma.prestamos.create.mockResolvedValue({ id: 100n });

    const id = await prestamos.create(
      { ...dtoLegacy, cuentaOrigenDesembolsoId: 4, crearTransaccionTransferencia: true },
      OWNER,
    );

    expect(id).toBe(100);
    expect(prisma.transacciones.create).toHaveBeenCalledTimes(1);
    expect(prisma.prestamos.create.mock.calls[0][0].data).toMatchObject({
      transaccion_desembolso_id: 66n,
      cuenta_origen_desembolso_id: 4n,
    });
  });
});

describe('PrestamosService.update — pasar a Pagado', () => {
  it("primero cambia el estado (el Trigger 4 abona saldo/valor) y DESPUÉS pone saldo_pendiente = 0", async () => {
    const { prisma, prestamos } = setup();
    prisma.prestamos.findFirst.mockResolvedValue({ id: 5n, estado: 'Pendiente', owner_user_id: OWNER });
    prisma.prestamos.update.mockResolvedValue({});

    await prestamos.update(5, { estado: 'Pagado' as any }, OWNER).catch(() => undefined); // getV2 final no tiene datos en el mock

    expect(prisma.prestamos.update).toHaveBeenCalledTimes(2);
    expect(prisma.prestamos.update.mock.calls[0][0].data).toEqual({ estado: 'Pagado' });
    expect(prisma.prestamos.update.mock.calls[1][0].data.saldo_pendiente.toString()).toBe('0');
  });

  it('no repite el cierre si ya estaba pagado', async () => {
    const { prisma, prestamos } = setup();
    prisma.prestamos.findFirst.mockResolvedValue({ id: 5n, estado: 'Pagado', owner_user_id: OWNER });
    await prestamos.update(5, { estado: 'Pagado' as any }, OWNER).catch(() => undefined);
    expect(prisma.prestamos.update).toHaveBeenCalledTimes(1);
  });

  it('saldo negativo → 400', async () => {
    const { prisma, prestamos } = setup();
    prisma.prestamos.findFirst.mockResolvedValue({ id: 5n, estado: 'Pendiente' });
    await expect(prestamos.update(5, { saldoPendiente: -1 }, OWNER)).rejects.toMatchObject({ status: 400 });
  });
});

describe('PrestamosService.resolverAprobacion', () => {
  const aprobacion = (linkedUserId: bigint | null, ownerPrestamo = OWNER) => ({
    id: 3n,
    prestamo_id: 5n,
    comentarios: null,
    prestamo: { owner_user_id: ownerPrestamo },
    persona: { linked_user_id: linkedUserId },
  });
  const user = (userId: bigint, role = 'user') => ({ userId, email: 'a@b.c', role, name: null });

  it('el dueño del libro puede aprobar', async () => {
    const { prisma, prestamos } = setup();
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue(aprobacion(null));
    prisma.aprobacionesPrestamos.update.mockImplementation(async ({ data }: any) => ({ id: 3n, prestamo_id: 5n, persona_id: 2n, persona: { nombre: 'Andrés' }, ...data }));
    const r = await prestamos.resolverAprobacion(5, 3, { estado: 'Aprobado' as any, comentarios: 'OK' }, user(OWNER));
    expect(r).toMatchObject({ id: 3, prestamoId: 5, personaId: 2, persona: 'Andrés', estado: 'Aprobado', comentarios: 'OK' });
    expect(typeof r.fechaAprobacion).toBe('string'); // ISO-8601
  });

  it('la persona enlazada (linked_user_id) puede rechazar su propia aprobación', async () => {
    const { prisma, prestamos } = setup();
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue(aprobacion(99n));
    prisma.aprobacionesPrestamos.update.mockImplementation(async ({ data }: any) => ({ id: 3n, prestamo_id: 5n, persona_id: 2n, ...data }));
    await expect(prestamos.resolverAprobacion(5, 3, { estado: 'Rechazado' as any }, user(99n))).resolves.toMatchObject({ estado: 'Rechazado' });
  });

  it('un tercero sin relación → 403; un ADMIN sí puede', async () => {
    const { prisma, prestamos } = setup();
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue(aprobacion(99n));
    prisma.aprobacionesPrestamos.update.mockResolvedValue({});
    await expect(prestamos.resolverAprobacion(5, 3, { estado: 'Aprobado' as any }, user(1234n))).rejects.toMatchObject({ status: 403 });
    await expect(prestamos.resolverAprobacion(5, 3, { estado: 'Aprobado' as any }, user(1234n, 'ADMIN'))).resolves.toBeDefined();
  });

  it('no permite volver a Pendiente y 404 si no existe', async () => {
    const { prisma, prestamos } = setup();
    await expect(prestamos.resolverAprobacion(5, 3, { estado: 'Pendiente' as any }, user(OWNER))).rejects.toMatchObject({ status: 400 });
    prisma.aprobacionesPrestamos.findFirst.mockResolvedValue(null);
    await expect(prestamos.resolverAprobacion(5, 3, { estado: 'Aprobado' as any }, user(OWNER))).rejects.toMatchObject({ status: 404 });
  });
});

describe('CortesCobroService', () => {
  it('activo: el corte cuyo rango contiene hoy; si no, el marcado ACTIVO', async () => {
    const { prisma, cortes } = setup();
    prisma.cortesCobro.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 9n });
    prisma.cortesCobro.findUniqueOrThrow.mockResolvedValue({ id: 9n, estado: 'ACTIVO' });
    const r = await cortes.activo(OWNER, utc('2026-10-13'));
    expect(prisma.cortesCobro.findFirst.mock.calls[0][0].where).toMatchObject({
      owner_user_id: OWNER,
      fecha_inicio: { lte: utc('2026-10-13') },
      fecha_final: { gte: utc('2026-10-13') },
    });
    expect(prisma.cortesCobro.findFirst.mock.calls[1][0].where).toEqual({ owner_user_id: OWNER, estado: 'ACTIVO' });
    expect(r).toEqual({ id: 9n, estado: 'ACTIVO' });
  });

  it('sin cortes → 404', async () => {
    const { cortes } = setup();
    await expect(cortes.activo(OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it('create valida el rango de fechas', async () => {
    const { prisma, cortes } = setup();
    prisma.cortesCobro.create.mockImplementation(async ({ data }: any) => data);
    await expect(cortes.create({ concepto: 'x', fechaInicio: '2026-10-08', fechaFinal: '2026-10-07' }, OWNER)).rejects.toMatchObject({ status: 400 });
    const r: any = await cortes.create({ concepto: 'Octubre 2026', fechaInicio: '2026-10-08', fechaFinal: '2026-11-07' }, OWNER);
    expect(r).toMatchObject({ owner_user_id: OWNER, estado: 'FUTURO' });
  });

  it('no elimina un corte con préstamos', async () => {
    const { prisma, cortes } = setup();
    prisma.cortesCobro.findFirst.mockResolvedValue({ id: 1n });
    prisma.prestamos.count.mockResolvedValue(4);
    await expect(cortes.remove(1, OWNER)).rejects.toMatchObject({ status: 409 });
    expect(prisma.cortesCobro.delete).not.toHaveBeenCalled();
  });
});

void dec;
