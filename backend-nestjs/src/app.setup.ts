import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { join } from 'node:path';
import { resolveCorsOrigins } from './config/env.validation';

/**
 * Alias de compatibilidad: la primera versión del plan publicaba el ERP bajo `/api/v2/*`. Las rutas definitivas están
 * en `/api/*` (cuentas-financieras, transacciones, recurrentes, ledger, analytics…). Se reescribe la URL antes del
 * enrutado, así que no aparecen duplicadas en Swagger.
 */
export const V2_ALIASES: Array<[RegExp, string]> = [
  [/^\/api\/v2\/subledger\//, '/api/ledger/'],
  [/^\/api\/v2\/dashboard\//, '/api/analytics/'],
  [/^\/api\/v2\/plantillas-recurrentes(?=[/?]|$)/, '/api/recurrentes/plantillas'],
  [/^\/api\/v2\/periodos-recurrentes\/proyectar(?=[/?]|$)/, '/api/recurrentes/proyectar-mes'],
  [/^\/api\/v2\/periodos-recurrentes\/(\d+)\/registrar-pago(?=[/?]|$)/, '/api/recurrentes/periodos/$1/pagar'],
  [/^\/api\/v2\/periodos-recurrentes(?=[/?]|$)/, '/api/recurrentes/periodos'],
  [/^\/api\/v2\//, '/api/'],
  [/^\/api\/v1\//, '/api/'],
];

export function reescribirAliasV2(url: string): string {
  for (const [patron, reemplazo] of V2_ALIASES) {
    if (patron.test(url)) return url.replace(patron, reemplazo);
  }
  return url;
}

/** CORS (equivale a `play.filters.cors` de application.conf) y estáticos (`/assets/*`). */
export function configureApp(app: NestExpressApplication): void {
  // Express limita el body a 100kb por defecto -> PayloadTooLargeError. Vercel permite máx. ~4.5MB.
  const limit = process.env.BODY_LIMIT ?? '4mb';
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: true });
  app.use((req: { url: string }, _res: unknown, next: () => void) => {
    req.url = reescribirAliasV2(req.url);
    next();
  });
  app.enableCors({
    origin: resolveCorsOrigins(),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Accept', 'Content-Type', 'Authorization', 'X-Requested-With', 'Csrf-Token', 'x-webhook-secret'],
    exposedHeaders: ['Content-Type', 'Authorization', 'Content-Disposition'],
    credentials: true,
    maxAge: 3600,
  });
  app.useStaticAssets(join(__dirname, '..', 'public'), { prefix: '/assets/' });
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Finanzas API')
    .setDescription(
      'API de finanzas personales y familiares (compras a crédito, tarjetas, préstamos, cuentas, transacciones, ' +
        'gastos recurrentes, obligaciones y sub-ledger de deudas). Rutas `/api/*` = contrato legacy (Play). ' +
        'Rutas `/api/v2/*` = ERP financiero (Supabase).',
    )
    .setVersion('2.0.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Swagger UI en `/api/docs` y JSON en `/api/docs-json` (la ruta legacy `/api-docs` se mantiene aparte). */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  const cdn = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    customCssUrl: `${cdn}/swagger-ui.css`,
    customJs: [`${cdn}/swagger-ui-bundle.js`, `${cdn}/swagger-ui-standalone-preset.js`],
  });
  return document;
}
