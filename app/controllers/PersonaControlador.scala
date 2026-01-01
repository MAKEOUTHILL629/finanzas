package controllers

import modelo.{Persona, Tarjeta}
import percistencia.{PersonaRepositorio, TarjetaRepositorio}
import play.api.libs.json.{Json, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import javax.inject._
import scala.concurrent.ExecutionContext

@Singleton
class PersonaControlador @Inject()(
controllerComponents: ControllerComponents,
personaRepositorio: PersonaRepositorio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

    implicit val personaEscritura: Writes[Persona] = Json.writes[Persona]

    def list() = Action.async { implicit request =>
        personaRepositorio.list().map { personas =>
            Ok(Json.toJson(personas))
        }
    }
}