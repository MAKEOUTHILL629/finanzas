package controllers

import modelo.CalculadoraAmortizacion.CuotaDetalle
import modelo.Tarjeta
import percistencia.{CuotaDetalleRepositorio, TarjetaRepositorio}
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.{JsPath, Json, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import javax.inject._
import scala.concurrent.ExecutionContext

@Singleton
class CuotaDetalleControlador @Inject()(
controllerComponents: ControllerComponents,
cuotaDetalleRepositorio: CuotaDetalleRepositorio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

//    case class CuotaDetalle(
//                             id: Int,
//                             numeroCuota: Int,
//                             fechaPago: Date,
//                             saldoRestante: Float,
//                             interesPagado: Float,
//                             aporteCapital: Float,
//                             pagoTotal: Float,
//                             compra: Int
//                           )

    implicit val cuotaDetalleWriter: Writes[CuotaDetalle] = Json.writes[CuotaDetalle]

    def listById(id: Int) = Action.async { implicit request =>
        cuotaDetalleRepositorio.listByCompra(id).map { cuotasDetalle =>
            Ok(Json.toJson(cuotasDetalle))
        }
    }
}