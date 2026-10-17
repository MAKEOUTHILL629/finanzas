/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { ComprasCreditoCsvService } from '../../src/modules/compras-credito/compras-credito-csv.service';
import { ComprasCreditoService } from '../../src/modules/compras-credito/compras-credito.service';
import { CuotasDetalleService } from '../../src/modules/compras-credito/cuotas-detalle.service';
import { PagosService } from '../../src/modules/compras-credito/pagos.service';
import { ResponsablesService } from '../../src/modules/compras-credito/responsables.service';
import { ConsultasPagosService } from '../../src/modules/consultas-pagos/consultas-pagos.service';
import { CobroPublicoService } from '../../src/modules/cobros/cobro-publico.service';
import { CobrosPuntualesService } from '../../src/modules/cobros/cobros-puntuales.service';
import { EnlacesCobroService } from '../../src/modules/cobros/enlaces-cobro.service';
import { ReportesPagoService } from '../../src/modules/cobros/reportes-pago.service';
import { CuentasFinancierasService } from '../../src/modules/cuentas-financieras/cuentas-financieras.service';
import { GastosRecurrentesService } from '../../src/modules/gastos-recurrentes/gastos-recurrentes.service';
import { NotificacionesCorreoService } from '../../src/modules/notificaciones-correo/notificaciones-correo.service';
import { EjecutorCorreosService } from '../../src/modules/notificaciones-correo/ejecutor-correos.service';
import { ProductosCorreoService } from '../../src/modules/notificaciones-correo/productos-correo.service';
import { ReprocesoCorreosService } from '../../src/modules/notificaciones-correo/reproceso-correos.service';
import { SyncBatchService } from '../../src/modules/notificaciones-correo/sync-batch.service';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service';
import { LookupService } from '../../src/modules/lookup/lookup.service';
import { EstadoCuentaPersonasService } from '../../src/modules/estado-cuenta-personas/estado-cuenta-personas.service';
import { CuotasTercerosService } from '../../src/modules/liquidacion-mensual/cuotas-terceros.service';
import { LiquidacionMensualService } from '../../src/modules/liquidacion-mensual/liquidacion-mensual.service';
import { AportesCarroService } from '../../src/modules/obligaciones-aportes/aportes-carro.service';
import { ObligacionesAportesService } from '../../src/modules/obligaciones-aportes/obligaciones-aportes.service';
import { CortesCobroService } from '../../src/modules/prestamos/cortes-cobro.service';
import { RecurrentesPersonaService } from '../../src/modules/recurrentes-persona/recurrentes-persona.service';
import { PrestamosService } from '../../src/modules/prestamos/prestamos.service';
import { SubledgerDeudasService } from '../../src/modules/subledger-deudas/subledger-deudas.service';
import { ProductosFinancierosService } from '../../src/modules/productos-financieros/productos-financieros.service';
import { SugerenciasService } from '../../src/modules/sugerencias/sugerencias.service';
import { RefinanciamientoService } from '../../src/modules/compras-credito/refinanciamiento.service';
import { PlasticosTarjetaService } from '../../src/modules/tarjetas/plasticos-tarjeta.service';
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
 * `sql/*.sql` (los objetos del documento de BD y los de aportes/cruces/recurrentes). Es DESTRUCTIVO (DROP SCHEMA public CASCADE), por eso
 * se niega a ejecutarse salvo contra localhost y una base cuyo nombre contenga "test".
 */

const RAIZ = join(__dirname, '..', '..');
const DIR_SQL = join(RAIZ, 'sql');

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

/** Scripts de `sql/` en orden: son EXACTAMENTE los que se aplican a Supabase (`node scripts/aplicar-sql.js`). */
function scriptsSql(): string[] {
  return readdirSync(DIR_SQL)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(DIR_SQL, f), 'utf8'));
}

/**
 * Objetos que define `sql/002` y que Prisma también conoce (están en schema.prisma). Se quitan antes de aplicar los
 * scripts para probar el camino real: esquema "existente" + migración (con sus CHECK, índices y FK).
 */
const QUITAR_ANTES_DE_MIGRAR = `
  ALTER TABLE "MovimientosDeudaPersona" DROP COLUMN IF EXISTS cargo_recurrente_persona_id, DROP COLUMN IF EXISTS obligacion_mes_id;
  DROP TABLE IF EXISTS "CargosRecurrentesPersona" CASCADE;
  ALTER TABLE "AportesDetalle" DROP COLUMN IF EXISTS cuenta_financiera_id, DROP COLUMN IF EXISTS transaccion_id, DROP COLUMN IF EXISTS origen_obligacion_mes_id;
  ALTER TABLE "ObligacionesMes" DROP COLUMN IF EXISTS saldo_a_favor_aplicado;
  -- 003 (correos inteligentes y cobros)
  DROP TABLE IF EXISTS "ReportesPagoPersona", "EnlacesCobroPersona", "CobrosPuntualesPersonas" CASCADE;
  ALTER TABLE "MovimientosDeudaPersona" DROP COLUMN IF EXISTS cobro_puntual_id;
  DROP TABLE IF EXISTS "CobrosPuntuales" CASCADE;
  ALTER TABLE "NotificacionesCorreo"
    DROP COLUMN IF EXISTS ultimos_4, DROP COLUMN IF EXISTS comercio_normalizado, DROP COLUMN IF EXISTS monto_original,
    DROP COLUMN IF EXISTS moneda, DROP COLUMN IF EXISTS tarjeta_id, DROP COLUMN IF EXISTS cuenta_id, DROP COLUMN IF EXISTS persona_id,
    DROP COLUMN IF EXISTS vinculo, DROP COLUMN IF EXISTS notificacion_original_id;
  ALTER TABLE "CuentasFinancieras" DROP COLUMN IF EXISTS es_principal;
  ALTER TABLE "Tarjetas" DROP COLUMN IF EXISTS ultimos_4_digitos;
  -- 006 (tarjetas de débito, vínculo tarjeta → cuenta y periodo de uso); al quitar la columna cae su FK
  ALTER TABLE "Tarjetas" DROP COLUMN IF EXISTS tipo_tarjeta, DROP COLUMN IF EXISTS cuenta_id, DROP COLUMN IF EXISTS alias, DROP COLUMN IF EXISTS es_generica;
  ALTER TABLE "CuentasFinancieras" DROP COLUMN IF EXISTS es_generica, DROP COLUMN IF EXISTS fecha_inicio_uso, DROP COLUMN IF EXISTS fecha_fin_uso;
  -- 004 (plásticos de tarjeta); ComprasCredito.plastico_id apunta a TarjetaPlasticos: primero la columna.
  ALTER TABLE "ComprasCredito" DROP COLUMN IF EXISTS plastico_id;
  DROP TABLE IF EXISTS "TarjetaPlasticos" CASCADE;
  -- 009 (refinanciamiento); al quitar refinanciamiento_id cae su FK y su CHECK
  ALTER TABLE "ComprasCredito" DROP COLUMN IF EXISTS refinanciamiento_id, DROP COLUMN IF EXISTS es_refinanciamiento, DROP COLUMN IF EXISTS saldo_refinanciado, DROP COLUMN IF EXISTS sistema_amortizacion, DROP COLUMN IF EXISTS cuota_fija_pactada;`;

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
    await client.query(QUITAR_ANTES_DE_MIGRAR);
    for (const script of scriptsSql()) await client.query(script);
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
  productosCorreo: ProductosCorreoService;
  reproceso: ReprocesoCorreosService;
  ejecutorCorreos: EjecutorCorreosService;
  obligaciones: ObligacionesAportesService;
  aportesCarro: AportesCarroService;
  recurrentesPersona: RecurrentesPersonaService;
  liquidacion: LiquidacionMensualService;
  estadoCuentaPersonas: EstadoCuentaPersonasService;
  dashboard: DashboardService;
  cortes: CortesCobroService;
  prestamos: PrestamosService;
  subledger: SubledgerDeudasService;
  tarjetas: TarjetasService;
  plasticos: PlasticosTarjetaService;
  productos: ProductosFinancierosService;
  transacciones: TransaccionesService;
  cobrosPuntuales: CobrosPuntualesService;
  enlacesCobro: EnlacesCobroService;
  reportesPago: ReportesPagoService;
  cobroPublico: CobroPublicoService;
  sugerencias: SugerenciasService;
  refinanciamientos: RefinanciamientoService;
  cuotasTerceros: CuotasTercerosService;
  pagosTarjeta: PagosService;
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
  const subledger = new SubledgerDeudasService(prisma);
  const recurrentesPersona = new RecurrentesPersonaService(prisma);
  recurrentesPersona.ttlGeneracionMs = 0; // las pruebas reinician la BD entre casos: siempre se genera
  const productosCorreo = new ProductosCorreoService(prisma);
  const cuotasTerceros = new CuotasTercerosService(prisma);
  const liquidacion = new LiquidacionMensualService(prisma, recurrentesPersona, subledger, cuotasTerceros);
  const estadoCuentaPersonas = new EstadoCuentaPersonasService(prisma, liquidacion, cuotasTerceros);
  const enlacesCobro = new EnlacesCobroService(prisma, liquidacion);
  const ejecutorCorreos = new EjecutorCorreosService(prisma, compras, transacciones, responsables, config);
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
    syncBatch: new SyncBatchService(prisma, ejecutorCorreos, productosCorreo),
    productosCorreo,
    reproceso: new ReprocesoCorreosService(prisma, ejecutorCorreos, productosCorreo),
    ejecutorCorreos,
    obligaciones: new ObligacionesAportesService(prisma),
    aportesCarro: new AportesCarroService(prisma, transacciones),
    recurrentesPersona,
    liquidacion,
    estadoCuentaPersonas,
    dashboard: new DashboardService(prisma, new LookupService(prisma), subledger, estadoCuentaPersonas),
    cortes: new CortesCobroService(prisma, prestamos),
    prestamos,
    subledger,
    tarjetas: new TarjetasService(prisma, new WebScrapingService(), config),
    plasticos: new PlasticosTarjetaService(prisma),
    productos: new ProductosFinancierosService(prisma),
    transacciones,
    cobrosPuntuales: new CobrosPuntualesService(prisma),
    enlacesCobro,
    reportesPago: new ReportesPagoService(prisma, enlacesCobro),
    cobroPublico: new CobroPublicoService(prisma),
    sugerencias: new SugerenciasService(prisma),
    refinanciamientos: new RefinanciamientoService(prisma, compras),
    cuotasTerceros,
    pagosTarjeta: new PagosService(prisma),
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
