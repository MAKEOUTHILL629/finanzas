/* eslint-disable no-console */
/**
 * Conexión a la base PostgreSQL para los scripts de `scripts/` (aplicar SQL, vincular refinanciamientos históricos…).
 * No imprime contraseñas ni la URL de conexión.
 */
const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { argumento, cargarEnv, resolverConexion, configCliente };
