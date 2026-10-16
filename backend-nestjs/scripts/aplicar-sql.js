#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Aplica los scripts de `sql/` (DDL idempotente) a una base PostgreSQL dentro de UNA transacción.
 *
 *   node scripts/aplicar-sql.js --dry-run            # aplica y hace ROLLBACK: muestra qué cambiaría
 *   node scripts/aplicar-sql.js                      # aplica y confirma (COMMIT)
 *   node scripts/aplicar-sql.js --archivos=001       # solo los que empiezan por 001
 *   node scripts/aplicar-sql.js --env=../.env        # .env de Scala (DB_URL, DB_USER, DB_PASSWORD); es el valor por defecto
 *   node scripts/aplicar-sql.js --database-url=postgresql://…   # base explícita (p. ej. una de pruebas)
 *
 * Requiere `npm run build` (usa dist/config/scala-env para derivar la URL del .env de Scala).
 * No imprime contraseñas ni la URL de conexión.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DIR_SQL = path.join(__dirname, '..', 'sql');

function argumento(nombre) {
  const prefijo = `--${nombre}=`;
  const a = process.argv.find((x) => x.startsWith(prefijo));
  return a ? a.slice(prefijo.length) : undefined;
}

function cargarEnv(ruta) {
  const env = {};
  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m || linea.trim().startsWith('#')) continue;
    let valor = m[2];
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    env[m[1]] = valor;
  }
  return env;
}

function resolverConexion() {
  const explicita = argumento('database-url') || process.env.APLICAR_SQL_DATABASE_URL;
  if (explicita) return explicita;

  const rutaEnv = path.resolve(process.cwd(), argumento('env') || path.join(__dirname, '..', '..', '.env'));
  if (!fs.existsSync(rutaEnv)) throw new Error(`No existe el .env de Scala en ${rutaEnv} (usa --env= o --database-url=)`);
  const dist = path.join(__dirname, '..', 'dist', 'config', 'scala-env.js');
  if (!fs.existsSync(dist)) throw new Error('Falta dist/: ejecuta `npm run build` primero');
  const { derivarUrlsPrisma } = require(dist);
  const urls = derivarUrlsPrisma(cargarEnv(rutaEnv));
  if (!urls) throw new Error('El .env no define DB_URL / DB_USER / DB_PASSWORD válidos');
  return urls.DIRECT_URL; // pooler en modo sesión: soporta transacciones y sentencias múltiples
}

function configCliente(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  const usuario = decodeURIComponent(u.username);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: usuario,
    password: decodeURIComponent(u.password),
    database: u.pathname.replace('/', '') || 'postgres',
    // Supabase exige TLS; su certificado del pooler no encadena con la CA del sistema.
    ssl: local ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  };
}

const CONSULTAS_OBJETOS = {
  tablas: `SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  vistas: `SELECT viewname AS n FROM pg_views WHERE schemaname = 'public' ORDER BY 1`,
  funciones: `SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`,
  triggers: `SELECT c.relname || '.' || t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE NOT t.tgisinternal AND ns.nspname = 'public' ORDER BY 1`,
  columnas: `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name IN ('ObligacionesMes','AportesDetalle','MovimientosDeudaPersona','CargosRecurrentesPersona',
               'Tarjetas','CuentasFinancieras','NotificacionesCorreo','CobrosPuntuales','CobrosPuntualesPersonas','EnlacesCobroPersona','ReportesPagoPersona',
               'ComprasCredito','TarjetaPlasticos') ORDER BY 1`,
  indices: `SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
};

async function inventario(client) {
  const salida = {};
  for (const [clave, sql] of Object.entries(CONSULTAS_OBJETOS)) {
    salida[clave] = new Set((await client.query(sql)).rows.map((r) => r.n));
  }
  return salida;
}

/** Tablas con datos del usuario: el DDL no debe cambiar su número de filas (un script que lo haga se cancela). */
const TABLAS_PROTEGIDAS = ['MovimientosDeudaPersona', 'ComprasCredito', 'CuotasDetalle', 'ResponsablesComprasCredito', 'Tarjetas', 'Prestamos', 'Personas'];

async function conteos(client) {
  const salida = {};
  for (const t of TABLAS_PROTEGIDAS) salida[t] = (await client.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
  return salida;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const filtro = argumento('archivos');
  const archivos = fs
    .readdirSync(DIR_SQL)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .filter((f) => !filtro || filtro.split(',').some((p) => f.startsWith(p)))
    .sort();
  if (archivos.length === 0) throw new Error('No hay archivos .sql que aplicar');

  const client = new Client(configCliente(resolverConexion()));
  await client.connect();
  const { rows: info } = await client.query('SELECT current_database() AS db, version() AS v');
  console.log(`Base: ${info[0].db} · ${String(info[0].v).split(' ').slice(0, 2).join(' ')} · modo: ${dryRun ? 'DRY-RUN (rollback)' : 'APLICAR (commit)'}`);

  const antes = await inventario(client);
  const conteosAntes = await conteos(client);

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '15s'");
    for (const archivo of archivos) {
      const sql = fs.readFileSync(path.join(DIR_SQL, archivo), 'utf8');
      await client.query(sql);
      console.log(`  ✓ ${archivo}`);
    }

    const despues = await inventario(client);
    const conteosDespues = await conteos(client);
    console.log('\nCambios en el esquema:');
    for (const clave of Object.keys(CONSULTAS_OBJETOS)) {
      const nuevos = [...despues[clave]].filter((n) => !antes[clave].has(n));
      const quitados = [...antes[clave]].filter((n) => !despues[clave].has(n));
      if (nuevos.length) console.log(`  + ${clave}: ${nuevos.join(', ')}`);
      if (quitados.length) console.log(`  - ${clave}: ${quitados.join(', ')}`);
    }
    console.log('\nFilas de las tablas con datos (el DDL no debe cambiarlas):');
    for (const t of TABLAS_PROTEGIDAS) console.log(`  ${t}: ${conteosAntes[t]} → ${conteosDespues[t]}`);
    const alteradas = TABLAS_PROTEGIDAS.filter((t) => conteosAntes[t] !== conteosDespues[t]);
    if (alteradas.length > 0) throw new Error(`El script modificó el número de filas de ${alteradas.join(', ')}: se cancela`);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN: ROLLBACK ejecutado, no se guardó nada.');
    } else {
      await client.query('COMMIT');
      console.log('\nCOMMIT ejecutado: cambios guardados.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('\nERROR: se hizo ROLLBACK, la base no cambió.');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
