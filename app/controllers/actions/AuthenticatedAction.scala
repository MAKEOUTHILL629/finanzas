package controllers.actions

import javax.inject.Inject
import play.api.mvc._
import play.api.libs.json.Json
import play.api.Configuration
import pdi.jwt.{JwtJson, JwtAlgorithm, JwtClaim, JwtOptions}
import scala.concurrent.{ExecutionContext, Future}
import scala.util.{Try, Success, Failure}


class AuthenticatedAction  @Inject()(
                                      parser: BodyParsers.Default,
                                      config: Configuration
                                    )(implicit override val executionContext: ExecutionContext)
  extends ActionBuilderImpl(parser) {

  private val secretKey = config.get[String]("play.http.secret.key")
  private val jwtAlgorithm = JwtAlgorithm.HS256 // Asegúrate que coincida con la firma

  override def invokeBlock[A](request: Request[A], block: (Request[A]) => Future[Result]): Future[Result] = {
    // 1. Obtener el token de la cabecera Authorization
    request.headers.get("Authorization") match {
      case Some(authHeader) if authHeader.startsWith("Bearer ") =>
        val token = authHeader.substring(7).trim // Extraer el token después de "Bearer "
        // 2. Decodificar y validar el token
        JwtJson.decode(token, secretKey, Seq(jwtAlgorithm)) match {
          case Success(claim) =>
            // ¡Token válido! El token ha sido verificado (firma y expiración)
            // Opcional: Puedes extraer datos del claim y añadirlos al request si es útil
            // val claimJson = Json.parse(claim.content)
            // val userId = (claimJson \ "userId").as[Long]
            // val userRole = (claimJson \ "role").as[String]
            // val userRequest = UserRequest(User(userId, ..., userRole), request) // Crear request enriquecida
            // block(userRequest) // Pasar la request enriquecida al bloque original

            // Ejecutar el bloque de código original del endpoint protegido
            block(request)

          case Failure(exception) =>
            // Token inválido (mala firma, expirado, malformado)
            Future.successful(Results.Unauthorized(Json.obj("status" -> "error", "message" -> "Invalid or expired token", "details" -> exception.getMessage)))
        }
      case _ =>
        // No se encontró la cabecera Authorization o no tiene el formato "Bearer "
        Future.successful(Results.Unauthorized(Json.obj("status" -> "error", "message" -> "Authorization header not found or invalid")))
    }
  }

  }

