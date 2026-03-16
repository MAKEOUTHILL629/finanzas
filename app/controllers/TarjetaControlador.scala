package controllers;

import modelo.Tarjeta
import percistencia.TarjetaRepositorio
import play.api.libs.json.{JsNull, JsString, Json, Writes}
import play.api.mvc.{AbstractController, ControllerComponents}
import servicios.{ResumenScraping, WebScrapingServicio}

import java.text.SimpleDateFormat
import scala.concurrent.{ExecutionContext, Future}
import javax.inject._

@Singleton
class TarjetaControlador @Inject()(
  controllerComponents: ControllerComponents,
  tarjetaRepositorio: TarjetaRepositorio,
  webScrapingServicio: WebScrapingServicio
)(implicit ec: ExecutionContext) extends AbstractController(controllerComponents) {

    private val isoFormat = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss")

    implicit val tarjetaEscritura: Writes[Tarjeta] = (t: Tarjeta) => Json.obj(
        "id"                       -> t.id,
        "franquicia"               -> t.franquicia,
        "fechaCreacion"            -> Option(t.fechaCreacion).fold[play.api.libs.json.JsValue](JsNull)(d => JsString(isoFormat.format(d))),
        "descripcion"              -> t.descripcion,
        "tasaInteresCompra"        -> t.tasaInteresCompra,
        "tasaInteresAvance"        -> t.tasaInteresAvance,
        "cuotaManejo"              -> t.cuotaManejo,
        "urlInfo"                  -> t.urlInfo,
        "ultimaActualizacionTasas" -> t.ultimaActualizacionTasas.fold[play.api.libs.json.JsValue](JsNull)(d => JsString(isoFormat.format(d))),
        "extractTasas"             -> t.extractTasas
    )

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

    /**
     * POST /api/tarjetas/actualizar-tasas
     *
     * Recorre todas las tarjetas con extract_tasas = true y url_info configurada.
     * Si la ultima_actualizacion_tasas tiene menos de 7 días, omite esa tarjeta.
     * Devuelve un resumen con el resultado de cada tarjeta.
     */
    def actualizarTasas() = Action.async { implicit request =>
        tarjetaRepositorio.listParaScraping().flatMap { tarjetas =>

            if (tarjetas.isEmpty) {
                Future.successful(Ok(Json.obj(
                    "mensaje" -> "No hay tarjetas configuradas para scraping (extract_tasas = true y url_info no nulo)",
                    "total" -> 0,
                    "resultados" -> Json.arr()
                )))
            } else {
                // Procesar cada tarjeta secuencialmente para no sobrecargar el sitio web
                val futuroResultados: Future[Seq[ResumenScraping]] =
                    tarjetas.foldLeft(Future.successful(Seq.empty[ResumenScraping])) { (acumulador, tarjeta) =>
                        acumulador.flatMap { resultadosAnteriores =>

                            if (!webScrapingServicio.necesitaActualizacion(tarjeta)) {
                                // Ya fue actualizada esta semana, omitir
                                val diasRestantes = tarjeta.ultimaActualizacionTasas.map { ultima =>
                                    val diff = System.currentTimeMillis() - ultima.getTime
                                    val dias = java.util.concurrent.TimeUnit.MILLISECONDS.toDays(diff)
                                    7 - dias
                                }.getOrElse(0L)

                                Future.successful(resultadosAnteriores :+ ResumenScraping(
                                    tarjetaId  = tarjeta.id,
                                    franquicia = tarjeta.franquicia,
                                    estado     = "OMITIDA",
                                    mensaje    = s"Actualizada recientemente. Próxima actualización disponible en $diasRestantes día(s)."
                                ))
                            } else {
                                // Realizar scraping con delay mínimo entre requests (2 segundos)
                                Thread.sleep(2000)

                                webScrapingServicio.extraerTasas(tarjeta).flatMap { resultado =>
                                    if (resultado.exitoso) {
                                        // Guardar en BD
                                        tarjetaRepositorio.actualizarTasas(
                                            id               = tarjeta.id,
                                            tasaInteresCompra = resultado.tasaInteresCompraMensual,
                                            tasaInteresAvance = resultado.tasaInteresAvanceMensual,
                                            cuotaManejo       = resultado.cuotaManejo
                                        ).map { _ =>
                                            resultadosAnteriores :+ ResumenScraping(
                                                tarjetaId  = tarjeta.id,
                                                franquicia = tarjeta.franquicia,
                                                estado     = "ACTUALIZADA",
                                                mensaje    = resultado.mensaje,
                                                resultado  = Some(resultado)
                                            )
                                        }
                                    } else {
                                        Future.successful(resultadosAnteriores :+ ResumenScraping(
                                            tarjetaId  = tarjeta.id,
                                            franquicia = tarjeta.franquicia,
                                            estado     = "ERROR",
                                            mensaje    = resultado.mensaje
                                        ))
                                    }
                                }
                            }
                        }
                    }

                futuroResultados.map { resultados =>
                    val actualizadas = resultados.count(_.estado == "ACTUALIZADA")
                    val omitidas     = resultados.count(_.estado == "OMITIDA")
                    val errores      = resultados.count(_.estado == "ERROR")

                    Ok(Json.obj(
                        "mensaje"      -> s"Proceso completado: $actualizadas actualizadas, $omitidas omitidas, $errores con error",
                        "total"        -> tarjetas.length,
                        "actualizadas" -> actualizadas,
                        "omitidas"     -> omitidas,
                        "errores"      -> errores,
                        "resultados"   -> resultados.map { r =>
                            val base = Json.obj(
                                "tarjetaId"  -> r.tarjetaId,
                                "franquicia" -> r.franquicia,
                                "estado"     -> r.estado,
                                "mensaje"    -> r.mensaje
                            )
                            r.resultado.fold(base) { res =>
                                base ++ Json.obj(
                                    "tasas" -> Json.obj(
                                        "interesCompraMensual" -> res.tasaInteresCompraMensual,
                                        "interesCompraAnual"   -> res.tasaInteresCompraAnual,
                                        "interesAvanceMensual" -> res.tasaInteresAvanceMensual,
                                        "interesAvanceAnual"   -> res.tasaInteresAvanceAnual,
                                        "cuotaManejo"          -> res.cuotaManejo
                                    )
                                )
                            }
                        }
                    ))
                }.recover {
                    case ex: Exception =>
                        InternalServerError(Json.obj(
                            "mensaje" -> s"Error en el proceso de scraping: ${ex.getMessage}"
                        ))
                }
            }
        }
    }

    /**
     * POST /api/tarjetas/:id/actualizar-tasas
     *
     * Fuerza la actualización de una tarjeta específica (ignora la restricción semanal).
     */
    def actualizarTasasTarjeta(id: Int) = Action.async { implicit request =>
        tarjetaRepositorio.findByIdOrFranquicia(id.toString).flatMap {
            case None =>
                Future.successful(NotFound(Json.obj("mensaje" -> s"No se encontró la tarjeta con id=$id")))

            case Some(tarjeta) if !tarjeta.extractTasas =>
                Future.successful(BadRequest(Json.obj(
                    "mensaje" -> "La tarjeta no tiene habilitado el scraping (extract_tasas = false)"
                )))

            case Some(tarjeta) if tarjeta.urlInfo.isEmpty =>
                Future.successful(BadRequest(Json.obj(
                    "mensaje" -> "La tarjeta no tiene URL configurada (url_info)"
                )))

            case Some(tarjeta) =>
                webScrapingServicio.extraerTasas(tarjeta).flatMap { resultado =>
                    if (resultado.exitoso) {
                        tarjetaRepositorio.actualizarTasas(
                            id                = tarjeta.id,
                            tasaInteresCompra  = resultado.tasaInteresCompraMensual,
                            tasaInteresAvance  = resultado.tasaInteresAvanceMensual,
                            cuotaManejo        = resultado.cuotaManejo
                        ).map { _ =>
                            Ok(Json.obj(
                                "mensaje"    -> "Tasas actualizadas correctamente",
                                "tarjetaId"  -> tarjeta.id,
                                "franquicia" -> tarjeta.franquicia,
                                "tasas" -> Json.obj(
                                    "interesCompraMensual" -> resultado.tasaInteresCompraMensual,
                                    "interesCompraAnual"   -> resultado.tasaInteresCompraAnual,
                                    "interesAvanceMensual" -> resultado.tasaInteresAvanceMensual,
                                    "interesAvanceAnual"   -> resultado.tasaInteresAvanceAnual,
                                    "cuotaManejo"          -> resultado.cuotaManejo
                                )
                            ))
                        }
                    } else {
                        Future.successful(UnprocessableEntity(Json.obj(
                            "mensaje"    -> resultado.mensaje,
                            "tarjetaId"  -> tarjeta.id,
                            "franquicia" -> tarjeta.franquicia
                        )))
                    }
                }
        }.recover {
            case ex: Exception =>
                InternalServerError(Json.obj("mensaje" -> s"Error inesperado: ${ex.getMessage}"))
        }
    }
}