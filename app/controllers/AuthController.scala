package controllers

import controllers.actions.AuthenticatedAction
import modelo.{User => UserModel}
import org.mindrot.jbcrypt.BCrypt
import pdi.jwt.{JwtAlgorithm, JwtClaim, JwtJson}
import percistencia.repository.UserService
import play.api.Configuration
import play.api.libs.json.{JsError, Json, Reads, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}
import scala.util.{Failure, Success}
import scala.util.control.NonFatal
class AuthController @Inject()(
                                cc: ControllerComponents,
                                userService: UserService,
                                config: Configuration,
                                authenticatedAction: AuthenticatedAction
                              )(implicit ec: ExecutionContext) extends AbstractController(cc) {

  // --- Configuración JWT (sin cambios) ---
  private val secretKey = config.get[String]("play.http.secret.key")
  private val jwtAlgorithm = JwtAlgorithm.HS256
  private val jwtExpiration = config.get[Long]("jwt.expiration")

  // --- Modelo para Request de Login (sin cambios) ---
  case class LoginRequest(email: String, password: String)
  implicit val loginReads: Reads[LoginRequest] = Json.reads[LoginRequest]

  // --- Función reutilizable para generar JWT ---
  private def generateJwtToken(user: UserModel): String = {
    val claim = JwtClaim(
      content = Json.obj(
        "userId" -> user.id,
        "email" -> user.email,
        "role" -> user.role,
        "name" -> user.name
      ).toString(),
      issuer = Some("Finanzas Makes"),
      expiration = Some(System.currentTimeMillis() / 1000 + jwtExpiration),
      issuedAt = Some(System.currentTimeMillis() / 1000)
    )
    JwtJson.encode(claim, secretKey, jwtAlgorithm)
  }

  // --- Acción de Login con Contraseña (ACTUALIZADA) ---
  def login = Action.async(parse.json) { implicit request =>
    request.body.validate[LoginRequest].fold(
      errors => Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "Invalid JSON format", "details" -> JsError.toJson(errors)))),
      loginData => {
        userService.findByEmail(loginData.email).map { maybeUser =>
          maybeUser match {
            case Some(user) =>
              // ¡IMPORTANTE! Verificar si el usuario tiene contraseña local
              user.passwordHash match {
                case Some(hash) =>
                  // Usuario tiene contraseña, verificarla
                  if (BCrypt.checkpw(loginData.password, hash)) {
                    // Contraseña correcta, generar token
                    val token = generateJwtToken(user)
                    Ok(Json.obj("status" -> "ok", "token" -> token))
                  } else {
                    // Contraseña incorrecta
                    Unauthorized(Json.obj("status" -> "error", "message" -> "Invalid email or password"))
                  }
                case None =>
                  // Usuario existe pero no tiene contraseña local (probablemente cuenta social)
                  // No permitir login con contraseña vacía
                  Unauthorized(Json.obj("status" -> "error", "message" -> "Password login not available for this account. Try social login."))
              }
            case None =>
              // Usuario no encontrado
              Unauthorized(Json.obj("status" -> "error", "message" -> "Invalid email or password"))
          }
        }.recover {
          case ex: Exception => InternalServerError(Json.obj("status" -> "error", "message" -> "Internal server error", "details" -> ex.getMessage))
        }
      }
    )
  }

  def tokenIsValid() = Action.async { implicit request =>
    // Extraer el token del encabezado Authorization
    request.headers.get("Authorization") match {
      case Some(authHeader) =>
        // Verificar que el encabezado tenga el formato "Bearer <token>"
        if (authHeader.startsWith("Bearer ")) {
          val token = authHeader.substring(7) // Remover "Bearer " del inicio

          // Validar el token JWT
          JwtJson.decode(token, secretKey, Seq(jwtAlgorithm)) match {
            case Success(claim) =>
              // Token válido, extraer información del usuario
              val emailUser = (Json.parse(claim.content) \ "email").as[String]
              userService.findByEmail(emailUser).map {
                case Some(user) =>
                  // Devolver información del usuario
                  Ok(Json.obj("status" -> "ok"))
                case None =>
                  // Usuario no encontrado
                  Unauthorized(Json.obj("status" -> "error", "message" -> "User not found"))
              }.recover {
                case NonFatal(ex) =>
                  InternalServerError(Json.obj("status" -> "error", "message" -> "Internal server error", "details" -> ex.getMessage))
              }
            case Failure(_) =>
              // Token inválido
              Future.successful(Unauthorized(Json.obj("status" -> "error", "message" -> "Invalid token")))
          }
        } else {
          // Formato de Authorization incorrecto
          Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "Invalid Authorization header format. Expected: Bearer <token>")))
        }
      case None =>
        // Falta el encabezado Authorization
        Future.successful(Unauthorized(Json.obj("status" -> "error", "message" -> "Missing Authorization header")))
    }
  }

  // --- Modelo para el Request de Registro ---
  case class RegisterRequest(
                              email: String,
                              password: String, // Contraseña en texto plano (¡la hashearemos!)
                              name: Option[String] // Nombre opcional
                            )

  implicit val registerReads: Reads[RegisterRequest] = Json.reads[RegisterRequest]

  implicit val userWrites: Writes[UserModel] = (user: UserModel) => Json.obj(
    "id" -> user.id,
    "email" -> user.email,
    "role" -> user.role,
    "name" -> user.name,
    "avatarUrl" -> user.avatarUrl
    // No incluir passwordHash
  )

  def register = Action.async(parse.json) { implicit request =>
    request.body.validate[RegisterRequest].fold(
      // Caso: JSON inválido
      errors => {
        Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "Invalid registration data", "details" -> JsError.toJson(errors))))
      },
      // Caso: JSON válido
      registerData => {
        // 1. Validar complejidad de la contraseña (ejemplo simple)
        if (registerData.password.length < 8) {
          Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "Password must be at least 8 characters long")))
        } else {
          // 2. Verificar si el email ya existe
          userService.findByEmail(registerData.email).flatMap { maybeExistingUser =>
            if (maybeExistingUser.isDefined) {
              // Email ya en uso
              Future.successful(Conflict(Json.obj("status" -> "error", "message" -> "Email already registered"))) // 409 Conflict
            } else {
              // 3. Email disponible, hashear la contraseña
              val passwordHash = BCrypt.hashpw(registerData.password, BCrypt.gensalt())
              val defaultRole = "user" // Rol por defecto para nuevos registros

              // 4. Llamar al servicio para crear el usuario
              userService.createUser(
                email = registerData.email,
                passwordHash = Some(passwordHash), // Pasar el hash
                name = registerData.name,
                role = defaultRole
              ).map { createdUser =>
                // 5. Usuario creado con éxito
                // Devolver el usuario creado (sin el hash) usando userWrites
                Created(Json.obj("status" -> "ok", "message" -> "User registered successfully", "user" -> Json.toJson(createdUser))) // 201 Created
              }.recover {
                // Manejo de errores específicos de la creación (ej. violación de constraint en BD real)
                case NonFatal(ex) =>
                  // Loggear el error real (ex) en un sistema de logging adecuado
                  InternalServerError(Json.obj("status" -> "error", "message" -> "Failed to create user", "details" -> ex.getMessage))
              }
            }
          }.recover {
            // Manejo de errores durante la búsqueda de email (ej. fallo de BD)
            case NonFatal(ex) =>
              // Loggear el error real (ex)
              InternalServerError(Json.obj("status" -> "error", "message" -> "Error checking email availability", "details" -> ex.getMessage))
          }
        }
      }
    )
  }

  // --- Placeholder para Callbacks de OAuth ---
  // Ejemplo para Google (necesitará una librería como play-pac4j o implementación manual)
  def oauthCallback(provider: String) = Action.async { implicit request =>
    println(s"Callback recibido para proveedor: $provider con params: ${request.queryString}")

    // ******** LÓGICA FUTURA DE OAUTH IRÍA AQUÍ ********
    // 1. Validar el estado (state) para prevenir CSRF.
    // 2. Extraer el código de autorización (code) de la query string.
    // 3. Intercambiar el código por un token de acceso con el proveedor OAuth (Google, Facebook...).
    //    (POST request al endpoint de token del proveedor con client_id, client_secret, code, redirect_uri).
    // 4. Usar el token de acceso para obtener la información del perfil del usuario desde el proveedor.
    //    (GET request al endpoint de userinfo/profile del proveedor con el token de acceso en la cabecera).
    // 5. Extraer datos clave: providerUserId (ID único del usuario en Google/FB), email, nombre, avatar.
    // 6. Llamar a nuestro servicio para encontrar o crear el usuario local:
    //    val providerUserId = "..." // ID de Google/FB
    //    val userEmail = "..."      // Email de Google/FB
    //    val userName = Some("...") // Nombre de Google/FB
    //    val userAvatar = Some("...") // Avatar de Google/FB
    //    userService.findOrCreateUser(provider, providerUserId, userEmail, userName, userAvatar).map { user =>
    //      // 7. Generar NUESTRO PROPIO JWT para el usuario encontrado/creado
    //      val appToken = generateJwtToken(user)
    //      // 8. Redirigir al frontend, pasando el token.
    //      //    Estrategia común: redirigir a una ruta específica del frontend con el token
    //      //    ej. /login/callback?token=<appToken> o usando fragment #token=<appToken>
    //      //    El frontend debe capturar este token y almacenarlo (localStorage).
    //      Redirect(s"/frontend/login/callback#token=$appToken", FOUND) // Redirigir a una ruta del frontend
    //    }.recover {
    //       case ex: Exception => InternalServerError("OAuth process failed: " + ex.getMessage)
    //    }

    // Placeholder actual:
    Future.successful(
      NotImplemented(Json.obj(
        "status" -> "pending",
        "message" -> s"OAuth callback for provider '$provider' not yet implemented.",
        "received_params" -> request.queryString
      ))
    )
    // ******************************************************
  }

  def logout = authenticatedAction { implicit request => // <-- USA TU ACTION BUILDER!
    // Si estás aquí, el usuario está autenticado (token válido y no expirado).

    // Opcional: Extraer información del usuario del token si AuthenticatedAction lo añade
    // o si decodificas el token aquí de nuevo (menos eficiente).
    // Asumiendo que AuthenticatedAction puede añadir el claim o userId a los atributos:
    // val userIdOpt = request.attrs.get(Attrs.UserIdKey) // Ejemplo si tuvieras Attrs.UserIdKey
    // val userDesc = userIdOpt.map(id => s"User ID: $id").getOrElse("Usuario desconocido (pero autenticado)")

    // 1. (Opcional pero recomendado) Registrar el evento de logout
    // Usando el logger de Play
    // logger.info(s"Logout successful for $userDesc from IP: ${request.remoteAddress}")
    // Podrías loggear directamente el claim si lo pasas en los atributos
    request.headers.get("Authorization").foreach { authHeader =>
      // ¡Cuidado! No loguees el token completo en producción si no es necesario.
      // Loguear solo la información necesaria, como el ID de usuario extraído del token.
    }


    // 2. (Avanzado - Lógica de Lista Negra / Blocklist - NO IMPLEMENTADO AQUÍ)
    //    Si tuvieras una lista negra de tokens (ej. en Redis/DB):
    //    - Extraer un identificador único del token (ej. 'jti' claim).
    //    - Añadir ese 'jti' a la lista negra con un TTL igual al tiempo restante de expiración del token.
    //    - Tu AuthenticatedAction/JwtFilter debería consultar esta lista negra ANTES de validar el token.
    //    logger.debug(s"Adding token identifier (jti?) to blocklist for $userDesc")
    //    tokenBlocklistService.blacklist(jti, expiresIn)


    // 3. Devolver una respuesta exitosa.
    //    No hay contenido que devolver realmente, así que 204 No Content es apropiado.
    //    O puedes devolver un 200 OK con un mensaje simple.
    NoContent // Código 204: Éxito, sin contenido que devolver.

    // Alternativa con mensaje (Código 200 OK):
    // Ok(Json.obj("status" -> "ok", "message" -> "Logged out successfully"))
  }

}