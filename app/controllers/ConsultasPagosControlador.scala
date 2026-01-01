package controllers

import modelo.{CompraCredito, PagosMensualesReponsable, PagosMensualesResponsableDetalle}
import percistencia.ConsultaPagosMensuales
import play.api.libs.functional.syntax.{toFunctionalBuilderOps, unlift}
import play.api.libs.json.{JsPath, Json, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import java.text.SimpleDateFormat
import java.time.LocalDate
import java.util.Date
import javax.inject.Inject
import scala.concurrent.ExecutionContext


class ConsultasPagosControlador @Inject()(controllerComponents: ControllerComponents,
                                    consultasRepositorio: ConsultaPagosMensuales )
                                  (implicit ec: ExecutionContext)
                                    extends AbstractController(controllerComponents){

  implicit val pagosMensualesPersonaEscritura: Writes[PagosMensualesReponsable] = {
    // Formateador de fecha
    val dateFormat = new SimpleDateFormat("MM/dd/yyyy")

    implicit val dateWrites: Writes[Date] = Writes.dateWrites("MM/dd/yyyy")

    (
      (JsPath \ "persona").write[Int] and
        (JsPath \ "fecha").write[Date] and
        (JsPath \ "valorPago").write[Float]
      )(unlift(PagosMensualesReponsable.unapply))
  }


  def listPagosMensualesPersona() = Action.async { implicit request =>
    consultasRepositorio.listPagosMensualesPersona().map { pagosMensuales =>
     // pagosMensuales.foreach(println)
      Ok(Json.toJson(pagosMensuales))
    }
  }

  implicit val PagosMensualesResponsableDetalleEscritura: Writes[PagosMensualesResponsableDetalle]= {
    // Formateador de fecha
    val dateFormat = new SimpleDateFormat("MM/dd/yyyy")

    implicit val dateWrites: Writes[Date] = Writes.dateWrites("MM/dd/yyyy")

    (
      (JsPath \ "persona").write[Int] and
        (JsPath \ "compraCredito").write[Int] and
        (JsPath \ "concepto").write[String] and
        (JsPath \ "porcentaje").write[Float] and
        (JsPath \ "cantidadCuotaTotal").write[Int] and
        (JsPath \ "numeroCuota").write[Int] and
        (JsPath \ "fechaPago").write[Date] and
        (JsPath \ "valorPagoCuota").write[Float] and
        (JsPath \ "valorPagoResponsable").write[Float] and
        (JsPath \ "tarjeta").write[Int] and
        (JsPath \ "estado").write[String] and
        (JsPath \ "interesPagado").write[Float] and
        (JsPath \ "aporteCapital").write[Float] and
        (JsPath \ "saldoRestante").write[Float]
      )(unlift(PagosMensualesResponsableDetalle.unapply))
  }


  def ListPagosMensualesResponsableDetalle(idPersona: Int) = Action.async { implicit request =>
    val mes : Option[String] =  request.getQueryString("mes");
    val year : Option[String] =  request.getQueryString("year");
    val fechaAnalisis : Option[(Int, Int)] = for {
      mes <- mes
      year <- year
    } yield (mes.toInt, year.toInt);

     fechaAnalisis match {
      case Some(fecha) => {
        consultasRepositorio.listPagosMensualesPersonaDetalle(idPersona, fecha._1, fecha._2).map { pagosMensualesDetalle =>
          Ok(Json.toJson(pagosMensualesDetalle))
        }
      }
      case None => {
        val mesActual: Int = LocalDate.now().getMonthValue
        val yearActual: Int = LocalDate.now().getYear
        consultasRepositorio.listPagosMensualesPersonaDetalle(idPersona, mesActual, yearActual).map { pagosMensualesDetalle =>
          Ok(Json.toJson(pagosMensualesDetalle))
        }
      }
    }

  }
}
