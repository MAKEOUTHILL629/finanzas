package controllers

import modelo.{Persona, ResponsableCompraCredito}
import percistencia.ResponsablesCompraCreditoRepositorio
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.{JsPath, Json, Reads, Writes, JsSuccess, JsError}
import play.api.mvc.{AbstractController, ControllerComponents}

import javax.inject._
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class ResponsableCompraCreditoControlador @Inject()(
controllerComponents: ControllerComponents,
responsablesCompraCreditoRepositorio: ResponsablesCompraCreditoRepositorio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

    implicit val responsableCompraCreditoWriter: Writes[ResponsableCompraCredito] = Json.writes[ResponsableCompraCredito]

    def list() = Action.async { implicit request =>
        responsablesCompraCreditoRepositorio.list().map { reponsables =>
            Ok(Json.toJson(reponsables))
        }
    }

    def listByCompraCredito(id: Int) = Action.async { implicit request =>
        responsablesCompraCreditoRepositorio.listByCompraCredito(id).map { reponsables =>
            Ok(Json.toJson(reponsables))
        }
    }



    implicit val reponsableCreditoReads : Reads[ResponsableCompraCredito] =  (
        (JsPath \ "persona").read[Int] and
        (JsPath \ "porcentajePago").read[Float] and
        (JsPath \ "cantidadPago").read[Float] and
        (JsPath \ "cantidadCuotas").read[Int] and
        (JsPath \ "compraCredito").read[Int]
    )(
        (persona, porcentajePago, cantidadPago, cantidadCuotas, compraCredito) =>
            ResponsableCompraCredito(0, null, persona, porcentajePago, cantidadPago, cantidadCuotas, compraCredito)
    )

    implicit val responsableCreditoUpdateReads: Reads[ResponsableCompraCredito] = (
        (JsPath \ "id").read[Int] and
        (JsPath \ "persona").read[Int] and
        (JsPath \ "porcentajePago").read[Float] and
        (JsPath \ "cantidadPago").read[Float] and
        (JsPath \ "cantidadCuotas").read[Int] and
        (JsPath \ "compraCredito").read[Int]
    )(
        (id, persona, porcentajePago, cantidadPago, cantidadCuotas, compraCredito) =>
            ResponsableCompraCredito(id, null, persona, porcentajePago, cantidadPago, cantidadCuotas, compraCredito)
    )

    def saveReponsableCredito() = Action(parse.json).async { implicit request =>
        request.body.validate[ResponsableCompraCredito](reponsableCreditoReads) match {
            case JsSuccess(responsable, _) =>
                responsablesCompraCreditoRepositorio.save(responsable).map { responsable =>
                    Ok(Json.obj("message" -> "Responsable de compra a crédito creado exitosamente", "id" -> responsable.id))
                }.recover {
                    case ex: Exception =>
                        InternalServerError(Json.obj("message" -> s"Error al crear el responsable: ${ex.getMessage}"))
                }
            case JsError(errors) =>
                Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
        }
    }

    def update() = Action(parse.json).async { implicit request =>
        request.body.validate[ResponsableCompraCredito](responsableCreditoUpdateReads) match {
            case JsSuccess(responsable, _) =>
                responsablesCompraCreditoRepositorio.update(responsable).map { _ =>
                    Ok(Json.obj("message" -> "Responsable actualizado exitosamente"))
                }.recover {
                    case ex: Exception =>
                        InternalServerError(Json.obj("message" -> s"Error al actualizar el responsable: ${ex.getMessage}"))
                }
            case JsError(errors) =>
                Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
        }
    }

    def delete(id: Int) = Action.async { implicit request =>
        responsablesCompraCreditoRepositorio.delete(id).map { _ =>
            Ok(Json.obj("message" -> "Responsable eliminado exitosamente"))
        }.recover {
            case ex: Exception =>
                InternalServerError(Json.obj("message" -> s"Error al eliminar el responsable: ${ex.getMessage}"))
        }
    }
}