/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { ComprasCreditoCsvService } from '../../src/modules/compras-credito/compras-credito-csv.service';
import { ComprasCreditoService } from '../../src/modules/compras-credito/compras-credito.service';
import { CuotasDetalleService } from '../../src/modules/compras-credito/cuotas-detalle.service';
import { PagosService } from '../../src/modules/compras-credito/pagos.service';
import { ResponsablesService } from '../../src/modules/compras-credito/responsables.service';
import { ConsultasPagosService } from '../../src/modules/consultas-pagos/consultas-pagos.service';
import { CuentasFinancierasService } from '../../src/modules/cuentas-financieras/cuentas-financieras.service';
import { GastosRecurrentesService } from '../../src/modules/gastos-recurrentes/gastos-recurrentes.service';
import { NotificacionesCorreoService } from '../../src/modules/notificaciones-correo/notificaciones-correo.service';
import { SyncBatchService } from '../../src/modules/notificaciones-correo/sync-batch.service';
import { ObligacionesAportesService } from '../../src/modules/obligaciones-aportes/obligaciones-aportes.service';
import { CortesCobroService } from '../../src/modules/prestamos/cortes-cobro.service';
import { PrestamosService } from '../../src/modules/prestamos/prestamos.service';
import { SubledgerDeudasService } from '../../src/modules/subledger-deudas/subledger-deudas.service';
import { TarjetasService } from '../../src/modules/tarjetas/tarjetas.service';
import { WebScrapingService } from '../../src/modules/tarjetas/web-scraping.service';
import { TransaccionesService } from '../../src/modules/transacciones/transacciones.service';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Arnés de integración contra PostgreSQL REAL (triggers y stored procedures incluidos).
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/finanzas_test npm run test:integration
 *
 * Reconstruye el esquema desde `prisma/schema.prisma` (DDL) y aplica el SQL de triggers, vistas y SPs de
 * "base de datos-documentacion.md" (secciones 4, 8, 10 y 11). Es DESTRUCTIVO (DROP SCHEMA public CASCADE), por eso
 * se niega a ejecutarse salvo contra localhost y una base cuyo nombre contenga "test".
 */

const RAIZ = join(__dirname, '..', '..');
const DOC_BD = join(RAIZ, '..', 'base de datos-documentacion.md');

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

function assertEsBaseDePruebas(url: string): void {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  const nombre = u.pathname.replace('/', '');
  if (!local || !/test/i.test(nombre)) {
    throw new Error(`Por seguridad el arnés solo corre contra localhost y una BD "*test*" (recibido: ${u.hostname}/${nombre})`);
  }
}

/** Bloques ```sql de la documentación que definen funciones, vistas o triggers. */
function sqlDeLaDocumentacion(): string[] {
  const md = readFileSync(DOC_BD, 'utf8');
  const bloques = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  return bloques
    .filter((b) => /CREATE OR REPLACE (FUNCTION|VIEW)/.test(b))
    .map((b) => b.replace(/DO \$\$[\s\S]*?END \$\$;/g, '')); // el DO añade un UNIQUE que Prisma ya creó
}

let esquemaListo = false;

export async function prepararEsquema(): Promise<void> {
  if (esquemaListo) return;
  const url = TEST_DATABASE_URL as string;
  assertEsBaseDePruebas(url);

  const ddl = execSync('npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script', {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    maxBuffer: 10 * 1024 * 1024,
  })
    // FKs estrictas (NO ACTION): cualquier borrado que olvide limpiar hijos debe fallar ruidosamente.
    .replace(/ON DELETE (SET NULL|RESTRICT|CASCADE)/g, 'ON DELETE NO ACTION');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await client.query(ddl);
    // Restricciones declaradas en el documento (sección 3.22) que Prisma no modela:
    await client.query(`
      ALTER TABLE "MovimientosDeudaPersona"
        ADD CONSTRAINT chk_mov_monto_positivo CHECK (monto > 0),
        ADD CONSTRAINT chk_mov_signo CHECK (signo IN (1, -1));
      ALTER TABLE "Tarjetas"
        ADD CONSTRAINT chk_tarjeta_dia_corte CHECK (dia_corte BETWEEN 1 AND 31);`);
    for (const bloque of sqlDeLaDocumentacion()) await client.query(bloque);
  } finally {
    await client.end();
  }
  esquemaListo = true;
}

export async function vaciarTablas(): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const tablas = rows.map((r: { tablename: string }) => `"${r.tablename}"`).join(', ');
    await client.query(`TRUNCATE ${tablas} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}

export interface Servicios {
  prisma: PrismaService;
  compras: ComprasCreditoService;
  csv: ComprasCreditoCsvService;
  cuotas: CuotasDetalleService;
  pagos: PagosService;
  responsables: ResponsablesService;
  consultas: ConsultasPagosService;
  cuentas: CuentasFinancierasService;
  recurrentes: GastosRecurrentesService;
  notificaciones: NotificacionesCorreoService;
  syncBatch: SyncBatchService;
  obligaciones: ObligacionesAportesService;
  cortes: CortesCobroService;
  prestamos: PrestamosService;
  subledger: SubledgerDeudasService;
  tarjetas: TarjetasService;
  transacciones: TransaccionesService;
}

export async function crearServicios(): Promise<Servicios> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const prisma = new PrismaService();
  await prisma.$connect();
  const config = { get: (k: string) => (k === 'SCRAPING_DELAY_MS' ? 0 : undefined) } as unknown as ConfigService;
  const transacciones = new TransaccionesService(prisma);
  const prestamos = new PrestamosService(prisma);
  const compras = new ComprasCreditoService(prisma);
  const responsables = new ResponsablesService(prisma);
  return {
    prisma,
    compras,
    csv: new ComprasCreditoCsvService(prisma, compras),
    cuotas: new CuotasDetalleService(prisma),
    pagos: new PagosService(prisma),
    responsables,
    consultas: new ConsultasPagosService(prisma),
    cuentas: new CuentasFinancierasService(prisma),
    recurrentes: new GastosRecurrentesService(prisma, transacciones),
    notificaciones: new NotificacionesCorreoService(prisma, transacciones, compras, responsables, prestamos, config),
    syncBatch: new SyncBatchService(prisma, compras, transacciones, config),
    obligaciones: new ObligacionesAportesService(prisma),
    cortes: new CortesCobroService(prisma, prestamos),
    prestamos,
    subledger: new SubledgerDeudasService(prisma),
    tarjetas: new TarjetasService(prisma, new WebScrapingService(), config),
    transacciones,
  };
}

export interface Semilla {
  userId: bigint;
  yoId: number; // Persona enlazada al usuario (linked_user_id)
  andresId: number;
  papaId: number;
  tarjetaId: number;
  bancolombiaId: number;
  nequiId: number;
  corteId: number;
}

/** Datos base de un usuario de prueba. Los IDs comienzan en 1 (TRUNCATE ... RESTART IDENTITY). */
export async function sembrar(prisma: PrismaService): Promise<Semilla> {
  const user = await prisma.users.create({ data: { email: 'felipe@example.com', role: 'user', name: 'Felipe', is_active: true } });
  const owner = user.id;
  const yo = await prisma.personas.create({ data: { nombre: 'Felipe', owner_user_id: owner, linked_user_id: owner } });
  const andres = await prisma.personas.create({ data: { nombre: 'Andrés', owner_user_id: owner, iniciales_nombre: 'AN' } });
  const papa = await prisma.personas.create({ data: { nombre: 'Papá', owner_user_id: owner } });
  const tarjeta = await prisma.tarjetas.create({ data: { franquicia: 'Visa', descripcion: 'Visa Oro', owner_user_id: owner } });
  const banco = await prisma.cuentasFinancieras.create({
    data: { owner_user_id: owner, nombre: 'Bancolombia', tipo_cuenta: 'AHORROS', ultimos_4_digitos: '1234', saldo_actual: '1000000.00' },
  });
  const nequi = await prisma.cuentasFinancieras.create({
    data: { owner_user_id: owner, nombre: 'Nequi', tipo_cuenta: 'BILLETERA_DIGITAL', saldo_actual: '0' },
  });
  const mesActual = mesRelativo(0);
  const corte = await prisma.cortesCobro.create({
    data: {
      owner_user_id: owner,
      concepto: `Corte ${mesActual}`,
      fecha_inicio: new Date(`${mesActual}-01T00:00:00Z`),
      fecha_final: new Date(`${finDeMes(mesActual)}T00:00:00Z`),
      estado: 'ACTIVO',
    },
  });
  return {
    userId: owner,
    yoId: Number(yo.id),
    andresId: Number(andres.id),
    papaId: Number(papa.id),
    tarjetaId: Number(tarjeta.id),
    bancolombiaId: Number(banco.id),
    nequiId: Number(nequi.id),
    corteId: Number(corte.id),
  };
}

/** `YYYY-MM` desplazado `n` meses respecto al mes actual (las pruebas no dependen de la fecha en que se ejecuten). */
export function mesRelativo(n: number, base: Date = new Date()): string {
  return new Date(Date.UTC(base.getFullYear(), base.getMonth() + n, 1)).toISOString().slice(0, 7);
}

/** Último día (YYYY-MM-DD) del periodo `YYYY-MM`. */
export function finDeMes(periodo: string): string {
  const [y, m] = periodo.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export const dec = (v: { toString(): string } | null | undefined): string => (v === null || v === undefined ? 'null' : v.toString());
