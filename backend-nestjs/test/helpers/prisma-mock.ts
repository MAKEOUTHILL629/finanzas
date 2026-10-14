/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';

/** Delegado de modelo con los métodos de Prisma más usados como jest.fn(). */
export function modelMock(): Record<string, jest.Mock> {
  return {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    delete: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  };
}

export const MODELOS = [
  'users',
  'personas',
  'tarjetas',
  'comprasCredito',
  'cuotasDetalle',
  'responsablesComprasCredito',
  'cuentasFinancieras',
  'categorias',
  'transacciones',
  'notificacionesCorreo',
  'plantillasRecurrentes',
  'responsablesRecurrentes',
  'periodosRecurrentes',
  'cortesCobro',
  'prestamos',
  'aprobacionesPrestamos',
  'obligacionesMes',
  'aportesDia',
  'aportesDetalle',
  'crucesDeuda',
  'movimientosDeudaPersona',
  'vw_ResumenObligacionesMes',
  'vw_AportesDiaResumen',
] as const;

/**
 * Prisma falso: cada modelo tiene delegados jest.fn(); `$transaction(cb)` ejecuta el callback con el mismo objeto
 * (así las llamadas hechas dentro de la transacción se pueden inspeccionar en un solo lugar).
 */
export function createPrismaMock(): any {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  for (const nombre of MODELOS) prisma[nombre] = modelMock();
  prisma.$transaction = jest.fn(async (arg: any) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  return prisma;
}

export const dec = (v: string | number) => new Prisma.Decimal(v);

/** SQL de una llamada a `$queryRaw`/`$executeRaw` con template literal. */
export function sqlDe(mock: jest.Mock, llamada = 0): string {
  const [strings] = mock.mock.calls[llamada] as [TemplateStringsArray | { sql?: string }];
  return Array.isArray(strings) ? (strings as string[]).join('?') : String((strings as { sql?: string }).sql ?? strings);
}

export function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
