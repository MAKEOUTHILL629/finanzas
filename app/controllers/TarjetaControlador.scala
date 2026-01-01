package controllers;

import modelo.Tarjeta
import percistencia.TarjetaRepositorio
import play.api.libs.json.{Json, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}

import scala.concurrent.{ExecutionContext, Future}
import javax.inject._

@Singleton
class TarjetaControlador @Inject()(
controllerComponents: ControllerComponents,
tarjetaRepositorio: TarjetaRepositorio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

    implicit val tarjetaEscritura: Writes[Tarjeta] = Json.writes[Tarjeta]

    def list() = Action.async { implicit request =>
        tarjetaRepositorio.list().map { tarjetas =>
            Ok(Json.toJson(tarjetas))
        }
    }

    val writesBalance = new Writes[(Int, String, Double)] {
        def writes(balance: (Int, String, Double)) = Json.obj(
            "tarjeta" -> balance._1,
            "franquicia" -> balance._2,
            "total_saldo_restante" -> balance._3
        )
    }

    def balanceTarjeta() = Action.async { implicit request =>

        val mes: Option[String] = request.getQueryString("mes");
        val year: Option[String] = request.getQueryString("year");


        val fechaAnalisis: Option[(Int, Int)] = for {
            mes <- mes
            year <- year
        } yield (mes.toInt, year.toInt);

        fechaAnalisis match {
            case Some(fecha) => {
                tarjetaRepositorio.listBalance( fecha._1, fecha._2).map { balanceTarjetaCredito =>
                    Ok(Json.toJson(balanceTarjetaCredito)(Writes.seq(writesBalance)))
                }
            }
            case None => Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos")))
        }
    }
}