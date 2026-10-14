package controllers

import play.api.mvc._
import javax.inject._

@Singleton
class SwaggerController @Inject()(cc: ControllerComponents) extends AbstractController(cc) {

  /** Sirve la interfaz Swagger UI (HTML con Swagger UI desde CDN) */
  def ui() = Action {
    Ok(swaggerHtml).as(HTML)
  }

  private val swaggerHtml: String =
    """<!DOCTYPE html>
      |<html lang="es">
      |<head>
      |  <meta charset="UTF-8" />
      |  <meta name="viewport" content="width=device-width, initial-scale=1" />
      |  <title>Finanzas API — Documentación</title>
      |  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
      |  <style>
      |    body { margin: 0; background: #fafafa; }
      |    .topbar { display: none; }
      |    .swagger-ui .info hgroup.main { margin: 0 0 20px 0; }
      |  </style>
      |</head>
      |<body>
      |  <div id="swagger-ui"></div>
      |  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
      |  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js"></script>
      |  <script>
      |    window.onload = function () {
      |      SwaggerUIBundle({
      |        url: "/api-docs/openapi.yaml",
      |        dom_id: '#swagger-ui',
      |        deepLinking: true,
      |        presets: [
      |          SwaggerUIBundle.presets.apis,
      |          SwaggerUIStandalonePreset
      |        ],
      |        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
      |        layout: "StandaloneLayout",
      |        tryItOutEnabled: true,
      |        requestInterceptor: function(req) {
      |          var token = localStorage.getItem('jwt_token');
      |          if (token) req.headers['Authorization'] = 'Bearer ' + token;
      |          return req;
      |        }
      |      });
      |    };
      |  </script>
      |</body>
      |</html>""".stripMargin
}

