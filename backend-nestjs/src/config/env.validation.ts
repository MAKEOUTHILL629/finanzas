import * as Joi from 'joi';

export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  'http://localhost:3000',
  'http://localhost', // frontend servido por nginx (docker)
  'http://localhost:8080',
  'https://www.makefinanzas.lat',
  'https://makefinanzas.lat',
  'https://d2k6anvt1vxcuu.cloudfront.net',
];

/**
 * Validación de variables de entorno.
 * `JWT_SECRET` es el nombre nuevo; `APP_SECRET` (play.http.secret.key) se acepta como fallback para que
 * el despliegue actual de AWS funcione como reemplazo directo (drop-in) y los JWT vigentes sigan siendo válidos.
 */
export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(9000),
  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().optional(),
  JWT_SECRET: Joi.string().min(16),
  APP_SECRET: Joi.string().min(16),
  JWT_EXPIRATION: Joi.number().integer().positive().default(3600),
  CORS_ORIGINS: Joi.string().allow('').optional(),
  SCRAPING_DELAY_MS: Joi.number().integer().min(0).default(2000),
  // Webhook de sincronización por lotes (Google Apps Script de correos de Bancolombia)
  WEBHOOK_SECRET: Joi.string().min(16).optional(),
  DEFAULT_OWNER_USER_ID: Joi.number().integer().positive().optional(),
  // Offset horario de los correos (America/Bogotá = -05:00, sin horario de verano)
  SYNC_TZ_OFFSET: Joi.string()
    .pattern(/^[+-]\d{2}:\d{2}$/)
    .default('-05:00'),
  // TRM de respaldo para compras en USD que llegan por correo sin tasa (se marcan trm_confirmada = false)
  DEFAULT_TRM_USD: Joi.number().positive().optional(),
})
  .or('JWT_SECRET', 'APP_SECRET')
  .unknown(true);

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const { value, error } = envSchema.validate(config, { abortEarly: false });
  if (error) {
    throw new Error(`Configuración de entorno inválida: ${error.message}`);
  }
  // Prisma Client lee directUrl del schema (env("DIRECT_URL")); si no se definió, reutiliza DATABASE_URL.
  if (!process.env.DIRECT_URL) process.env.DIRECT_URL = String(value.DATABASE_URL);
  return value;
}

export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET ?? env.APP_SECRET;
  if (!secret) throw new Error('Falta JWT_SECRET (o APP_SECRET)');
  return secret;
}

export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS;
  if (!raw || !raw.trim()) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
