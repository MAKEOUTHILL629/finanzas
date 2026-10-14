import { aplicarCompatibilidadScala, derivarUrlsPrisma, parseJdbcPostgres } from '../src/config/scala-env';

const JDBC_SUPABASE = 'jdbc:postgresql://aws-0-us-east-1.pooler.supabase.com:6543/postgres?prepareThreshold=0';

describe('parseJdbcPostgres', () => {
  it('separa host, puerto, base y parámetros', () => {
    const p = parseJdbcPostgres(JDBC_SUPABASE);
    expect(p).toMatchObject({ host: 'aws-0-us-east-1.pooler.supabase.com', port: '6543', base: 'postgres' });
    expect(p?.params.get('prepareThreshold')).toBe('0');
  });

  it('puerto por defecto 5432 y sin parámetros', () => {
    expect(parseJdbcPostgres('jdbc:postgresql://db.local/finanzas')).toMatchObject({ host: 'db.local', port: '5432', base: 'finanzas' });
  });

  it('rechaza lo que no es un JDBC de PostgreSQL', () => {
    expect(parseJdbcPostgres('postgresql://x/y')).toBeNull();
    expect(parseJdbcPostgres('jdbc:mysql://x/y')).toBeNull();
    expect(parseJdbcPostgres('')).toBeNull();
  });
});

describe('derivarUrlsPrisma', () => {
  const env = { DB_URL: JDBC_SUPABASE, DB_USER: 'postgres.abcdefghijkl', DB_PASSWORD: 'pa$$w@rd/with:odd#chars%1' };

  it('pooler de transacciones: pgbouncer=true y pool de 5 (HikariCP maximumPoolSize); DIRECT_URL en 5432', () => {
    const r = derivarUrlsPrisma(env);
    expect(r?.DATABASE_URL).toMatch(/^postgresql:\/\/postgres\.abcdefghijkl:.+@aws-0-us-east-1\.pooler\.supabase\.com:6543\/postgres\?pgbouncer=true&connection_limit=5$/);
    expect(r?.DIRECT_URL).toMatch(/@aws-0-us-east-1\.pooler\.supabase\.com:5432\/postgres$/);
  });

  it('la contraseña con caracteres especiales sobrevive al viaje por la URL', () => {
    const url = new URL(derivarUrlsPrisma(env)!.DATABASE_URL);
    expect(decodeURIComponent(url.password)).toBe(env.DB_PASSWORD);
    expect(decodeURIComponent(url.username)).toBe(env.DB_USER);
    expect(url.hostname).toBe('aws-0-us-east-1.pooler.supabase.com');
  });

  it('conexión directa (sin prepareThreshold ni 6543): sin pgbouncer y mismo puerto', () => {
    const r = derivarUrlsPrisma({ DB_URL: 'jdbc:postgresql://db.local:5432/finanzas', DB_USER: 'u', DB_PASSWORD: 'p' });
    expect(r?.DATABASE_URL).toBe('postgresql://u:p@db.local:5432/finanzas?connection_limit=5');
    expect(r?.DIRECT_URL).toBe('postgresql://u:p@db.local:5432/finanzas');
  });

  it('DB_POOL_SIZE ajusta connection_limit y sslmode se conserva', () => {
    const r = derivarUrlsPrisma({ DB_URL: 'jdbc:postgresql://h:5432/d?sslmode=require', DB_USER: 'u', DB_PASSWORD: 'p', DB_POOL_SIZE: '12' });
    expect(r?.DATABASE_URL).toBe('postgresql://u:p@h:5432/d?connection_limit=12&sslmode=require');
    expect(r?.DIRECT_URL).toBe('postgresql://u:p@h:5432/d?sslmode=require');
  });

  it('faltan variables o JDBC inválido → null', () => {
    expect(derivarUrlsPrisma({})).toBeNull();
    expect(derivarUrlsPrisma({ DB_URL: JDBC_SUPABASE, DB_USER: 'u' })).toBeNull();
    expect(derivarUrlsPrisma({ DB_URL: JDBC_SUPABASE, DB_USER: 'u', DB_PASSWORD: '' })).toBeNull();
    expect(derivarUrlsPrisma({ DB_URL: 'mongodb://x', DB_USER: 'u', DB_PASSWORD: 'p' })).toBeNull();
  });
});

describe('aplicarCompatibilidadScala', () => {
  it('define DATABASE_URL y DIRECT_URL y devuelve solo sus nombres', () => {
    const env: NodeJS.ProcessEnv = { DB_URL: JDBC_SUPABASE, DB_USER: 'u', DB_PASSWORD: 'p' };
    expect(aplicarCompatibilidadScala(env)).toEqual(['DATABASE_URL', 'DIRECT_URL']);
    expect(env.DATABASE_URL).toContain('pgbouncer=true');
  });

  it('un DATABASE_URL explícito de NestJS nunca se sobrescribe', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgresql://explicita', DB_URL: JDBC_SUPABASE, DB_USER: 'u', DB_PASSWORD: 'p' };
    expect(aplicarCompatibilidadScala(env)).toEqual([]);
    expect(env.DATABASE_URL).toBe('postgresql://explicita');
    expect(env.DIRECT_URL).toBeUndefined();
  });

  it('un DIRECT_URL explícito se respeta', () => {
    const env: NodeJS.ProcessEnv = { DIRECT_URL: 'postgresql://directa', DB_URL: JDBC_SUPABASE, DB_USER: 'u', DB_PASSWORD: 'p' };
    expect(aplicarCompatibilidadScala(env)).toEqual(['DATABASE_URL']);
    expect(env.DIRECT_URL).toBe('postgresql://directa');
  });

  it('sin variables de Scala no hace nada', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(aplicarCompatibilidadScala(env)).toEqual([]);
    expect(env).toEqual({});
  });
});
