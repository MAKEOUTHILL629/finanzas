import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp } from './app.helper';

/**
 * Checkpoint Fase 3: TODAS las rutas de `conf/routes` (Play) existen en NestJS con el mismo verbo y path.
 * Lee el archivo original del repo Scala (solo lectura) y hace una petición por ruta:
 *  - ruta inexistente  → 404
 *  - ruta protegida    → 401 (el guard actúa DESPUÉS de resolver la ruta)
 *  - ruta pública      → cualquier otro código
 */
const ROUTES_FILE = join(__dirname, '..', '..', '..', 'conf', 'routes');

interface LegacyRoute {
  method: string;
  path: string;
  action: string;
}

function readLegacyRoutes(): LegacyRoute[] {
  return readFileSync(ROUTES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ method: m[1], path: m[2], action: m[3] }));
}

/** `:id` → 1, `:provider` → google, `*file` → un archivo real de /public. */
function concretar(path: string): string {
  return path
    .replace(/\*file/, 'images/favicon.png')
    .replace(/:provider/, 'google')
    .replace(/:\w+/g, '1');
}

const PUBLICAS = new Set([
  'GET /',
  'GET /health',
  'GET /api-docs',
  'GET /api-docs/',
  'GET /api-docs/openapi.yaml',
  'GET /assets/*file',
  'POST /api/auth/login',
  'POST /api/auth/register',
  'GET /api/auth/callback/:provider',
  'GET /api/auth/token-is-valid',
]);

describe('Paridad de rutas con conf/routes', () => {
  let app: NestExpressApplication;
  const legacy = readLegacyRoutes();

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it('el archivo conf/routes se leyó y tiene las 36 rutas esperadas', () => {
    expect(legacy).toHaveLength(36);
  });

  it.each(readLegacyRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))('%s existe', async (_nombre, ruta) => {
    const url = concretar(ruta.path);
    const res = await (request(app.getHttpServer()) as any)[ruta.method.toLowerCase()](url).send();

    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);

    if (PUBLICAS.has(`${ruta.method} ${ruta.path}`)) {
      // Pública: el guard JWT no la bloquea (aunque pueda responder 400/401/501 por su propia lógica).
      expect(res.body).not.toEqual({ status: 'error', message: 'Authorization header required' });
    } else {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ status: 'error', message: 'Authorization header required' });
    }
  });

  it('rutas públicas devuelven lo esperado', async () => {
    const http = request(app.getHttpServer());
    expect((await http.get('/')).body).toEqual({ application: 'Finanzas API', version: '1.0', status: 'running' });
    expect((await http.get('/health')).body).toMatchObject({ status: 'UP', database: 'connected' });
    const ui = await http.get('/api-docs/');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    expect(ui.text).toContain('SwaggerUIBundle');
    const yaml = await http.get('/api-docs/openapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('openapi: 3.0.3');
    expect((await http.get('/assets/images/favicon.png')).status).toBe(200);
    expect((await http.post('/api/auth/login').send({})).status).toBe(400);
    expect((await http.get('/api/auth/callback/google?code=abc')).status).toBe(501);
    expect((await http.get('/api/auth/token-is-valid')).status).toBe(401);
  });

  it('las rutas del ERP (y sus alias /api/v2/*) existen y exigen JWT', async () => {
    const http = request(app.getHttpServer());
    for (const ruta of [
      '/api/cuentas-financieras',
      '/api/categorias',
      '/api/transacciones?periodo=2026-10',
      '/api/notificaciones-correo?estado_procesamiento=PENDIENTE',
      '/api/recurrentes/plantillas',
      '/api/recurrentes/periodos?periodo=2026-10',
      '/api/obligaciones-mes',
      '/api/obligaciones-mes/1/dias',
      '/api/cortes-cobro',
      '/api/cruces-deuda',
      '/api/ledger/estado-cuenta?periodo=2026-10',
      '/api/ledger/personas/1/extracto?periodo=2026-10',
      '/api/analytics/flujo-caja?periodo=2026-10',
      '/api/tarjetas/resumen-mensual?periodo=2026-10',
      // aportes del carro, recurrentes por persona y liquidación mensual
      '/api/obligaciones-aportes/carro/resumen',
      '/api/recurrentes-persona',
      '/api/recurrentes-persona/1',
      '/api/liquidacion-mensual/2026-10',
      '/api/liquidacion-mensual/2026-10/persona/1',
      // alias de la primera versión del plan
      '/api/v2/cuentas-financieras',
      '/api/v2/plantillas-recurrentes',
      '/api/v2/periodos-recurrentes?periodo=2026-10',
      '/api/v2/subledger/estado-cuenta?periodo=2026-10',
      '/api/v2/dashboard/flujo-caja?periodo=2026-10',
      '/api/v2/obligaciones-mes/1/aportes-dia',
      '/api/v2/obligaciones-aportes/carro/resumen',
      '/api/v2/recurrentes-persona',
      '/api/v2/liquidacion-mensual/2026-10',
    ]) {
      const res = await http.get(ruta);
      expect([ruta, res.status]).toEqual([ruta, 401]);
    }
    for (const [metodo, ruta] of [
      ['post', '/api/recurrentes/proyectar-mes'],
      ['post', '/api/notificaciones-correo/sync-batch'],
      ['post', '/api/personas/1/abonar'],
      ['post', '/api/tarjetas/1/pagar-extracto'],
      ['patch', '/api/compras-credito/1/confirmar-trm'],
      ['patch', '/api/recurrentes/periodos/1/pagar'],
      ['patch', '/api/prestamos/1/aprobaciones'],
      ['put', '/api/transacciones/1'],
      ['put', '/api/cortes-cobro/1'],
      ['put', '/api/compras-credito/1'],
      ['put', '/api/tarjetas/1'],
      ['patch', '/api/tarjetas/1'],
      ['post', '/api/obligaciones-aportes/periodos'],
      ['post', '/api/obligaciones-aportes/periodos/1/aplicar-excedente'],
      ['post', '/api/obligaciones-aportes/aportes-diarios'],
      ['put', '/api/obligaciones-aportes/aportes-diarios/1'],
      ['patch', '/api/obligaciones-aportes/aportes-diarios/1'],
      ['delete', '/api/obligaciones-aportes/aportes-diarios/1'],
      ['post', '/api/recurrentes-persona'],
      ['patch', '/api/recurrentes-persona/1'],
      ['delete', '/api/recurrentes-persona/1'],
      ['post', '/api/recurrentes-persona/generar-mes/2026-10'],
      ['post', '/api/liquidacion-mensual/cruce-entre-personas'],
      ['post', '/api/liquidacion-mensual/registrar-pago'],
      ['post', '/api/v2/obligaciones-aportes/aportes-diarios'],
    ] as const) {
      const res = await (http as any)[metodo](ruta).send({});
      expect([metodo, ruta, res.status === 404]).toEqual([metodo, ruta, false]);
    }
  });

  it('el OpenAPI generado (/api/docs-json) documenta las rutas legacy y del ERP, con Bearer', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    for (const esperada of [
      '/api/compras-credito',
      '/api/compras-credito/upload-csv',
      '/api/compras-credito/{id}',
      '/api/tarjetas/actualizar-tasas',
      '/api/auth/login',
      '/api/compras-credito/{id}/confirmar-trm',
      '/api/tarjetas/{id}/pagar-extracto',
      '/api/tarjetas/{id}',
      '/api/tarjetas/resumen-mensual',
      '/api/cuentas-financieras',
      '/api/categorias',
      '/api/transacciones',
      '/api/notificaciones-correo',
      '/api/notificaciones-correo/sync-batch',
      '/api/notificaciones-correo/{id}/conciliar',
      '/api/recurrentes/plantillas',
      '/api/recurrentes/proyectar-mes',
      '/api/recurrentes/periodos',
      '/api/recurrentes/periodos/{id}/pagar',
      '/api/prestamos',
      '/api/prestamos/{id}/aprobaciones',
      '/api/prestamos/{id}/aprobaciones/{aprobacionId}',
      '/api/cortes-cobro',
      '/api/obligaciones-mes',
      '/api/obligaciones-mes/{id}/dias',
      '/api/obligaciones-mes/{id}/aportes-dia',
      '/api/obligaciones-aportes/carro/resumen',
      '/api/obligaciones-aportes/periodos',
      '/api/obligaciones-aportes/periodos/{id}/aplicar-excedente',
      '/api/obligaciones-aportes/aportes-diarios',
      '/api/obligaciones-aportes/aportes-diarios/{id}',
      '/api/recurrentes-persona',
      '/api/recurrentes-persona/{id}',
      '/api/recurrentes-persona/generar-mes/{periodo}',
      '/api/liquidacion-mensual/{periodo}',
      '/api/liquidacion-mensual/{periodo}/persona/{personaId}',
      '/api/liquidacion-mensual/cruce-entre-personas',
      '/api/liquidacion-mensual/registrar-pago',
      '/api/cruces-deuda',
      '/api/personas/{id}/abonar',
      '/api/ledger/estado-cuenta',
      '/api/ledger/personas/{personaId}/extracto',
      '/api/analytics/flujo-caja',
    ]) {
      expect(paths).toContain(esperada);
    }
    expect(res.body.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});
