package controllers

import modelo.Prestamo
import percistencia.PrestamoRepositorio
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.{JsError, JsPath, JsSuccess, Json, Reads, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import java.text.SimpleDateFormat
import java.util.Date
import javax.inject._
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class PrestamoControlador @Inject()(
controllerComponents: ControllerComponents,
prestamoRepositorio: PrestamoRepositorio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

    implicit val prestamoEscritura: Writes[Prestamo] = Json.writes[Prestamo]

    def list() = Action.async { implicit request =>
        prestamoRepositorio.list().map { prestamos =>
            Ok(Json.toJson(prestamos))
        }
    }


    val dateFormat = new SimpleDateFormat("yyyy-MM-dd")

    implicit val prestamoReads: Reads[Prestamo] = (
        (JsPath \ "valorPrestado").read[Float] and
        (JsPath \ "concepto").read[String] and
        (JsPath \ "fechaCobro").read[String].map(s => new Date(dateFormat.parse(s).getTime)) and
        (JsPath \ "responsable").read[Int] and
        (JsPath \ "estado").read[String] and
        (JsPath \ "comentarios").read[String]
    )(
        (valorPrestado, concepto, fechaCobro, responsable, estado, comentarios) =>
            Prestamo(0, null, valorPrestado, concepto, fechaCobro, responsable, estado, comentarios)
    )

    def save() = Action(parse.json).async { implicit request =>
        request.body.validate[Prestamo] match {
            case JsSuccess(nuevoPrestamo, _) =>
                prestamoRepositorio.save(nuevoPrestamo).map { prestamo =>
                    Ok(Json.obj("message" -> "Prestamo creado exitosamente", "id" -> prestamo.id))
                }.recover {
                    case ex: Exception =>
                        InternalServerError(Json.obj("message" -> s"Error al crear el prestamo: ${ex.getMessage}"))
                }
            case JsError(errors) =>
                Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors)))
                )
        }
    }
}