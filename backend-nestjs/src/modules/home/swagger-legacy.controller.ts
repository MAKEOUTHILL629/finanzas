import { Controller, Get, Header, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Public } from '../../common/decorators/public.decorator';

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finanzas API — Documentación</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
    .swagger-ui .info hgroup.main { margin: 0 0 20px 0; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: "/api-docs/openapi.yaml",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: "StandaloneLayout",
        tryItOutEnabled: true,
        requestInterceptor: function(req) {
          var token = localStorage.getItem('jwt_token');
          if (token) req.headers['Authorization'] = 'Bearer ' + token;
          return req;
        }
      });
    };
  </script>
</body>
</html>`;

/**
 * Rutas Swagger heredadas de Play (`SwaggerController.ui` + `Assets.at(openapi.yaml)`).
 * La documentación nueva de NestJS vive en `/api/docs` y `/api/docs-json` (ver main.ts).
 */
@ApiExcludeController()
@Public()
@Controller('api-docs')
export class SwaggerLegacyController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  ui(): string {
    return SWAGGER_HTML;
  }

  @Get('openapi.yaml')
  @Header('Content-Type', 'application/yaml; charset=utf-8')
  yaml(): string {
    try {
      // dist/modules/home -> raíz del proyecto (../../..) / public / swagger
      return readFileSync(join(__dirname, '..', '..', '..', 'public', 'swagger', 'openapi.yaml'), 'utf8');
    } catch {
      throw new NotFoundException('openapi.yaml no encontrado');
    }
  }
}
