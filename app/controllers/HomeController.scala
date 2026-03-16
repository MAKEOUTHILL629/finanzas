package controllers

import javax.inject._
import play.api.mvc._
import play.api.libs.json.Json
import play.api.db.Database

/**
 * This controller creates an `Action` to handle HTTP requests to the
 * application's home page.
 */
@Singleton
class HomeController @Inject()(
  val controllerComponents: ControllerComponents,
  db: Database
) extends BaseController {

  /**
   * Create an Action to render an HTML page.
   *
   * The configuration in the `routes` file means that this method
   * will be called when the application receives a `GET` request with
   * a path of `/`.
   */
  def index(): Action[AnyContent] = Action { implicit request: Request[AnyContent] =>
    Ok(Json.obj(
      "application" -> "Finanzas API",
      "version" -> "1.0",
      "status" -> "running"
    ))
  }

  /**
   * Health check endpoint para AWS ELB/ECS
   * Verifica que la aplicación y la base de datos estén funcionando
   */
  def health(): Action[AnyContent] = Action { implicit request: Request[AnyContent] =>
    try {
      // Verificar conexión a la base de datos
      db.withConnection { conn =>
        val stmt = conn.createStatement()
        val rs = stmt.executeQuery("SELECT 1")
        rs.next()
        rs.close()
        stmt.close()
      }

      // Si llegamos aquí, todo está bien
      Ok(Json.obj(
        "status" -> "UP",
        "database" -> "connected",
        "timestamp" -> System.currentTimeMillis()
      ))
    } catch {
      case e: Exception =>
        InternalServerError(Json.obj(
          "status" -> "DOWN",
          "database" -> "disconnected",
          "error" -> e.getMessage,
          "timestamp" -> System.currentTimeMillis()
        ))
    }
  }
}



