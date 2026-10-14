/**
 * Exporta el documento OpenAPI de NestJS a `openapi-generated.json` SIN necesitar base de datos.
 *
 *   npm run openapi:export
 *
 * Uso en el proyecto Angular:
 *   npx @openapitools/openapi-generator-cli generate \
 *     -i ../finanzas/backend-nestjs/openapi-generated.json \
 *     -g typescript-angular -o src/app/api
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Valores ficticios solo si no están definidos: el script no abre conexiones a la BD.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://export:export@localhost:5432/export';
process.env.JWT_SECRET = process.env.JWT_SECRET || process.env.APP_SECRET || 'openapi-export-secret-0000';

async function main() {
  require('../dist/config/decimal.config');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { buildOpenApiDocument } = require('../dist/app.setup');

  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildOpenApiDocument(app);
  const destino = join(__dirname, '..', 'openapi-generated.json');
  writeFileSync(destino, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`OpenAPI exportado: ${destino} (${Object.keys(document.paths).length} paths)`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
