/**
 * Compatibilidad "drop-in" con el contenedor Scala (Play): el mismo `.env` (`DB_URL`, `DB_USER`, `DB_PASSWORD`,
 * `APP_SECRET`, `JWT_EXPIRATION`) sirve para la API NestJS sin reescribir nada.
 *
 *  - `APP_SECRET` → ya se acepta como respaldo de `JWT_SECRET` (ver `env.validation.ts`).
 *  - `DB_URL` (JDBC) + `DB_USER` + `DB_PASSWORD` → `DATABASE_URL` / `DIRECT_URL` de Prisma (este archivo).
 *
 * Solo se rellena lo que NO esté definido: `DATABASE_URL`/`DIRECT_URL` explícitos siempre ganan.
 */

/** Equivale a `db.default.hikaricp.maximumPoolSize = 5` de `application.conf`. */
const POOL_POR_DEFECTO = 5;
const PUERTO_POOLER_TRANSACCION = '6543';
const PUERTO_POOLER_SESION = '5432';

interface JdbcPostgres {
  host: string;
  port: string;
  base: string;
  params: URLSearchParams;
}

export function parseJdbcPostgres(jdbcUrl: string): JdbcPostgres | null {
  const m = /^jdbc:postgres(?:ql)?:\/\/([^/:?#]+)(?::(\d+))?\/([^?#]+)(?:\?(.*))?$/.exec(jdbcUrl.trim());
  if (!m) return null;
  return { host: m[1], port: m[2] ?? '5432', base: m[3], params: new URLSearchParams(m[4] ?? '') };
}

function construirUrl(usuario: string, password: string, host: string, port: string, base: string, query: URLSearchParams): string {
  // El usuario de Supabase lleva punto (`postgres.<ref>`) y la contraseña puede traer `@ : / # %`: se codifican.
  const credenciales = `${encodeURIComponent(usuario)}:${encodeURIComponent(password)}`;
  const qs = query.toString();
  return `postgresql://${credenciales}@${host}:${port}/${base}${qs ? `?${qs}` : ''}`;
}

/**
 * `jdbc:postgresql://host:6543/postgres?prepareThreshold=0` → `postgresql://user:pass@host:6543/postgres?pgbouncer=true&connection_limit=5`.
 * `prepareThreshold=0` (JDBC sin sentencias preparadas) es el equivalente de `pgbouncer=true` en Prisma; el pooler de
 * transacciones de Supabase (6543) lo necesita igualmente. `DIRECT_URL` (solo para el CLI de Prisma) usa el pooler en modo sesión.
 */
export function derivarUrlsPrisma(env: NodeJS.ProcessEnv): { DATABASE_URL: string; DIRECT_URL: string } | null {
  const { DB_URL, DB_USER, DB_PASSWORD } = env;
  if (!DB_URL || !DB_USER || DB_PASSWORD === undefined || DB_PASSWORD === '') return null;
  const jdbc = parseJdbcPostgres(DB_URL);
  if (!jdbc) return null;

  const pooler = jdbc.params.get('prepareThreshold') === '0' || jdbc.port === PUERTO_POOLER_TRANSACCION;
  const tamanoPool = Number(env.DB_POOL_SIZE) > 0 ? String(Math.floor(Number(env.DB_POOL_SIZE))) : String(POOL_POR_DEFECTO);

  const query = new URLSearchParams();
  if (pooler) query.set('pgbouncer', 'true');
  query.set('connection_limit', tamanoPool);
  const sslmode = jdbc.params.get('sslmode');
  if (sslmode) query.set('sslmode', sslmode);

  const queryDirecta = new URLSearchParams();
  if (sslmode) queryDirecta.set('sslmode', sslmode);
  const puertoDirecto = jdbc.port === PUERTO_POOLER_TRANSACCION ? PUERTO_POOLER_SESION : jdbc.port;

  return {
    DATABASE_URL: construirUrl(DB_USER, DB_PASSWORD, jdbc.host, jdbc.port, jdbc.base, query),
    DIRECT_URL: construirUrl(DB_USER, DB_PASSWORD, jdbc.host, puertoDirecto, jdbc.base, queryDirecta),
  };
}

/** Rellena `DATABASE_URL`/`DIRECT_URL` desde las variables de Scala. Devuelve los nombres que definió (sin valores). */
export function aplicarCompatibilidadScala(env: NodeJS.ProcessEnv = process.env): string[] {
  const aplicadas: string[] = [];
  if (env.DATABASE_URL) return aplicadas; // configuración explícita de NestJS: no se toca nada
  const derivadas = derivarUrlsPrisma(env);
  if (!derivadas) return aplicadas;
  env.DATABASE_URL = derivadas.DATABASE_URL;
  aplicadas.push('DATABASE_URL');
  if (!env.DIRECT_URL) {
    env.DIRECT_URL = derivadas.DIRECT_URL;
    aplicadas.push('DIRECT_URL');
  }
  return aplicadas;
}
