package controllers.filters

import org.apache.pekko.stream.Materializer

import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}
import play.api.mvc._
import play.api.libs.json.Json
import play.api.Configuration
import pdi.jwt.{JwtAlgorithm, JwtJson, JwtOptions}

import scala.util.{Failure, Success}

class JwtFilter @Inject()(
                           implicit val mat: Materializer, // Materializer es necesario para los Filters
                           ec: ExecutionContext,
                           config: Configuration) extends Filter { // Extiende de Filter

  private val secretKey = config.get[String]("play.http.secret.key")
  private val jwtAlgorithm = JwtAlgorithm.HS256

  // Lista de prefijos de rutas que NO deben ser filtradas (públicas)
  private val excludedPaths: Seq[String] = Seq(
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/callback/",
    "/api/auth/token-is-valid"// Excluir base de callbacks OAuth
    // Añade aquí otras rutas públicas que necesites (ej. /health, /metrics, /assets)
  )

  // Implementación del método apply del Filter
  def apply(nextFilter: RequestHeader => Future[Result]) // Función que llama al siguiente filtro o a la acción
           (requestHeader: RequestHeader): Future[Result] = { // La cabecera de la petición entrante

    // --- Lógica de Exclusión y Verificación ---

    // 1. Permitir peticiones OPTIONS (importante para CORS preflight)
    if (requestHeader.method == "OPTIONS") {
      return nextFilter(requestHeader) // Pasar al siguiente filtro/acción
    }

    // 2. Verificar si la ruta debe ser excluida del filtro de autenticación
    val path = requestHeader.path
    val isExcluded = excludedPaths.exists(prefix => path.startsWith(prefix))

    // Opcional: Solo aplicar filtro a rutas bajo /api/ (si tienes otras rutas como /assets)
    val shouldFilter = path.startsWith("/api/") && !isExcluded

    if (!shouldFilter) {
      // Si no se debe filtrar (es pública o no es /api/), continuar normalmente
      nextFilter(requestHeader)
    } else {
      // --- Si la ruta debe ser filtrada, aplicar lógica de verificación JWT ---
      requestHeader.headers.get("Authorization") match {
        case Some(authHeader) if authHeader.startsWith("Bearer ") =>
          val token = authHeader.substring(7).trim
          JwtJson.decode(token, secretKey, Seq(jwtAlgorithm)) match {
            case Success(claim) =>
              // Token válido, continuar la cadena de filtros/acción
              // Opcional: Podrías añadir info del claim a los Attrs del request aquí si es necesario,
              // aunque es un poco más complejo que en ActionBuilder.
              // ej: nextFilter(requestHeader.addAttr(Attrs.JwtClaimKey, claim))
              //println(s"JWT Válido para ${requestHeader.path}. Claim: ${claim.content}") // Log de depuración
              nextFilter(requestHeader) // Continuar al siguiente filtro o acción

            case Failure(exception) =>
              // Token inválido (firma, expiración, formato)
              println(s"JWT Inválido para ${requestHeader.path}: ${exception.getMessage}") // Log de depuración
              Future.successful(
                Results.Unauthorized(Json.obj("status" -> "error", "message" -> "Invalid or expired token", "details" -> exception.getMessage))
              )
          }
        case _ =>
          // No se encontró cabecera Authorization o no tiene formato Bearer
          println(s"Cabecera Authorization ausente/inválida para ${requestHeader.path}") // Log de depuración
          Future.successful(
            Results.Unauthorized(Json.obj("status" -> "error", "message" -> "Authorization header required"))
          )
      }
    }
  } // Fin de apply
}