package controllers

import modelo.{Persona, ResponsableCompraCredito}
import percistencia.ResponsablesCompraCreditoRepositorio
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.{JsPath, Json, Reads, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import javax.inject._
import scala.concurrent.ExecutionContext

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

    def saveReponsableCredito() = Action.async { implicit request =>
        val json = request.body.asJson.get
        val responsable = json.as[ResponsableCompraCredito]
        responsablesCompraCreditoRepositorio.save(responsable).map { responsable =>
            Ok(Json.obj("message" -> "Responsable de compra a crédito creado exitosamente", "id" -> responsable.id))
        }
    }
}