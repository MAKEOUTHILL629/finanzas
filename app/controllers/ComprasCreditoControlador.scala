package controllers

import modelo.CalculadoraAmortizacion.CuotaDetalle
import modelo.{CompraCredito, CuotaDetalleMes, PagoCreditosMesTarjeta}
import percistencia.CompraCreditoRepositorio
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.OFormat.oFormatFromReadsAndOWrites
import play.api.libs.json._
import play.api.libs.json.{Json, Writes}
import play.api.mvc.{AbstractController, Action, ControllerComponents}
import servicios.{CompraCreditoServicio, PagosServicio}

import java.text.SimpleDateFormat
import java.util.Date
import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}




class ComprasCreditoControlador@Inject()(
                                          controllerComponents: ControllerComponents,
                                          compraCreditoRepositorio: CompraCreditoRepositorio,
                                          compraService : CompraCreditoServicio,
                                          pagoService: PagosServicio
                                        )(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

  implicit val compraCreditoEscritura: Writes[CompraCredito] = Json.writes[CompraCredito]

  def list() = Action.async { implicit request =>
    compraCreditoRepositorio.list().map { compras =>
      Ok(Json.toJson(compras))
    }
  }

  def listById(idCompra: Int) = Action.async { implicit request =>
    compraCreditoRepositorio.get(idCompra).map { compras =>
      Ok(Json.toJson(compras))
    }
  }


  val dateFormat = new SimpleDateFormat("yyyy-MM-dd")


  // Implicit Reads para parsear el JSON a CompraCredito
  implicit val compraCreditoReads: Reads[CompraCredito] = (
    (JsPath \ "concepto").read[String] and
      (JsPath \ "valorCompra").read[Float] and
      (JsPath \ "fechaCompra").read[String].map(s => new Date(dateFormat.parse(s).getTime)) and
      (JsPath \ "numeroCuotas").read[Int] and
      (JsPath \ "interes").read[Float] and
      (JsPath \ "descripcion").read[String] and
      (JsPath \ "estado").read[String] and
      (JsPath \ "tarjeta").read[Int]
    )(
    (concepto, valorCompra, fechaCompra, numeroCuotas, interes, descripcion, estado, tarjeta) =>
      CompraCredito(0, null, concepto, valorCompra, fechaCompra, numeroCuotas, fechaCompra, valorCompra, interes, descripcion, estado, tarjeta, "", 0)
  )

  def create(): Action[JsValue] = Action(parse.json).async { implicit request =>
    request.body.validate[CompraCredito] match {
      case JsSuccess(nuevaCompra, _) =>
        compraService.save(nuevaCompra).map { id =>
          Ok(Json.obj("message" -> "Compra a crédito creada exitosamente", "id" -> id))
        }.recover {
          case ex: Exception =>
            InternalServerError(Json.obj("message" -> s"Error al crear la compra a crédito: ${ex.getMessage}"))
        }
      case JsError(errors) =>
        Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
    }
  }

  val compraCreditoUpdateReads: Reads[CompraCredito] = (
    (JsPath \ "id").read[Int] and
      (JsPath \ "concepto").read[String] and
      (JsPath \ "valorCompra").read[Float] and
      (JsPath \ "fechaCompra").read[String].map(s => new Date(dateFormat.parse(s).getTime)) and
      (JsPath \ "numeroCuotas").read[Int] and
      (JsPath \ "interes").read[Float] and
      (JsPath \ "descripcion").read[String] and
      (JsPath \ "estado").read[String] and
      (JsPath \ "tarjeta").read[Int]
    )(
    (id, concepto, valorCompra, fechaCompra, numeroCuotas, interes, descripcion, estado, tarjeta) =>
      CompraCredito(id, null, concepto, valorCompra, fechaCompra, numeroCuotas, fechaCompra, valorCompra, interes, descripcion, estado, tarjeta, "", 0)
  )

  def recalcularCuotas(): Action[JsValue] = Action(parse.json).async { implicit request =>
    request.body.validate[CompraCredito](compraCreditoUpdateReads) match {
      case JsSuccess(compra, _) =>
        compraService.recalcularCuotas(compra).map { cuotas =>
          Ok(Json.toJson(cuotas))
        }.recover {
          case ex: Exception =>
            InternalServerError(Json.obj("message" -> s"Error al recalcular las cuotas: ${ex.getMessage}"))
        }
      case JsError(errors) =>
        Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
    }
  }


  implicit val pagoMesCreditoEscritura: Writes[PagoCreditosMesTarjeta] = Json.writes[PagoCreditosMesTarjeta]

  def pagoTotalMesTarjeta() = Action.async { implicit request =>

    pagoService.calcularPagoTarjetasCredito().map { pagos =>
      Ok(Json.toJson(pagos))
    }

  }

  implicit val cuotaDetalleEscritura: Writes[CuotaDetalle] = Json.writes[CuotaDetalle]
  implicit val pagoMesCreditoDetalleEscritura: Writes[(CuotaDetalle, Int, String)] = new Writes[(CuotaDetalle, Int, String)] {
    def writes(tuple: (CuotaDetalle, Int, String)) = {
      val (cuota, tarjeta, concepto) = tuple
      Json.obj(
        "id" -> cuota.id,
        "numeroCuota" -> cuota.numeroCuota,
        "fechaPago" -> cuota.fechaPago,
        "saldoRestante" -> cuota.saldoRestante,
        "interesPagado" -> cuota.interesPagado,
        "aporteCapital" -> cuota.aporteCapital,
        "pagoTotal" -> cuota.pagoTotal,
        "compra" -> cuota.compra,
        "estado" -> cuota.estado,
        "tarjeta" -> tarjeta,
        "concepto" -> concepto
      )
    }
  }

  implicit val cuotaDetalleMesOFormat: OFormat[CuotaDetalleMes] = Json.format[CuotaDetalleMes]

  def pagoTotalMesTarjetaDetalle(tarjeta: Int) = Action.async { implicit request =>
    val mes: Option[String] = request.getQueryString("mes");
    val year: Option[String] = request.getQueryString("year");
    val fechaAnalisis: Option[(Int, Int)] = for {
      mes <- mes
      year <- year
    } yield (mes.toInt, year.toInt);


    fechaAnalisis match {
      case Some(fecha) => {
        pagoService.calcularPagoTarjetaCreditoDetalle(tarjeta, fecha._2, fecha._1).map { pagos =>
          Ok(Json.toJson(pagos))
        }
      }
      case None => Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos")))
    }
  }


  def pagarProductosTarjetaCredito() = Action.async { implicit request =>
    pagoService.pagarProductosTarjetaCredito().map { pagos =>
      Ok(Json.toJson(pagos))
    }
  }

  def cambioEstadoAjusteInteres(idTarjeta: Int) = Action.async { implicit request =>
    compraService.ajusteInteresTarjetaCredito(idTarjeta).map { _ =>
      Ok(Json.obj("message" -> "Estado cambiado"))
    }
  }

}