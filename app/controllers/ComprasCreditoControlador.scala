package controllers

import modelo.CalculadoraAmortizacion.CuotaDetalle
import modelo.{CompraCredito, CompraCreditoCsv, CuotaDetalleMes, PagoCreditosMesTarjeta}
import percistencia.{CompraCreditoRepositorio, TarjetaRepositorio}
import play.api.libs.functional.syntax.toFunctionalBuilderOps
import play.api.libs.json.OFormat.oFormatFromReadsAndOWrites
import play.api.libs.json._
import play.api.libs.json.{Json, Writes}
import play.api.mvc.{AbstractController, Action, ControllerComponents, MultipartFormData}
import servicios.{CompraCreditoServicio, PagosServicio}

import java.text.SimpleDateFormat
import java.util.Date
import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}
import org.apache.commons.csv.{CSVFormat, CSVParser, CSVPrinter}
import java.io.{FileWriter, StringWriter}
import java.nio.charset.StandardCharsets
import scala.jdk.CollectionConverters._
import scala.util.{Try, Success, Failure}

class ComprasCreditoControlador@Inject()(
                                          controllerComponents: ControllerComponents,
                                          compraCreditoRepositorio: CompraCreditoRepositorio,
                                          tarjetaRepositorio: TarjetaRepositorio,
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

  def delete(id: Int) = Action.async { implicit request =>
    compraService.delete(id).map { _ =>
      Ok(Json.obj("message" -> "Compra a crédito eliminada exitosamente"))
    }.recover {
      case ex: Exception =>
        InternalServerError(Json.obj("message" -> s"Error al eliminar la compra a crédito: ${ex.getMessage}"))
    }
  }

  def update() = Action(parse.json).async { implicit request =>
    request.body.validate[CompraCredito](compraCreditoUpdateReads) match {
      case JsSuccess(compra, _) =>
        compraService.updateCompra(compra).map { _ =>
          Ok(Json.obj("message" -> "Compra a crédito actualizada exitosamente"))
        }.recover {
          case ex: Exception =>
            InternalServerError(Json.obj("message" -> s"Error al actualizar la compra a crédito: ${ex.getMessage}"))
        }
      case JsError(errors) =>
        Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
    }
  }

  // Método auxiliar para detectar el delimitador del CSV
  private def detectDelimiter(file: java.io.File): Char = {
    val reader = new java.io.BufferedReader(new java.io.FileReader(file, StandardCharsets.UTF_8))
    val firstLine = reader.readLine()
    reader.close()

    if (firstLine != null) {
      val commaCount = firstLine.count(_ == ',')
      val semicolonCount = firstLine.count(_ == ';')
      if (semicolonCount > commaCount) ';' else ','
    } else {
      ','
    }
  }

  // Método auxiliar para normalizar nombres de columnas (case-insensitive)
  private def getColumnValue(record: org.apache.commons.csv.CSVRecord, columnNames: Seq[String]): String = {
    val headerMap = record.getParser.getHeaderMap.asScala
    columnNames.flatMap { name =>
      headerMap.keys.find(_.toLowerCase == name.toLowerCase).map(record.get)
    }.headOption.getOrElse("").trim
  }

  // Método auxiliar para parsear decimales (soporta punto y coma)
  private def parseDecimal(value: String): Try[Float] = {
    if (value.isEmpty) {
      Failure(new NumberFormatException("Valor vacío"))
    } else {
      // Normalizar el decimal: reemplazar coma por punto
      val normalized = value.replace(",", ".")
      Try(normalized.toFloat)
    }
  }

  // Método auxiliar para parsear fechas en múltiples formatos
  private def parseFecha(fechaStr: String): Option[Date] = {
    if (fechaStr.isEmpty) {
      return Some(new Date())
    }

    val formatos = Seq(
      new SimpleDateFormat("yyyy-MM-dd"),  // 2024-04-05
      new SimpleDateFormat("dd/MM/yyyy"),  // 05/04/2024
      new SimpleDateFormat("dd-MM-yyyy"),  // 05-04-2024
      new SimpleDateFormat("dd,MM,yyyy"),  // 05,04,2024
      new SimpleDateFormat("yyyy/MM/dd"),  // 2024/04/05
      new SimpleDateFormat("dd.MM.yyyy")   // 05.04.2024
    )

    formatos.flatMap { formato =>
      Try(new Date(formato.parse(fechaStr).getTime)).toOption
    }.headOption.orElse(Some(new Date())) // Si falla todo, usar fecha actual
  }

  def uploadCsv() = Action.async(parse.multipartFormData) { implicit request =>
    request.body.file("file") match {
      case Some(filePart) =>
        val file = filePart.ref.path.toFile

        Try {
          // Detectar el delimitador automáticamente
          val delimiter = detectDelimiter(file)
          val csvFormat = CSVFormat.DEFAULT
            .withDelimiter(delimiter)
            .withFirstRecordAsHeader()
            .withIgnoreEmptyLines(true)
            .withTrim()

          val parser = CSVParser.parse(file, StandardCharsets.UTF_8, csvFormat)
          val records = parser.getRecords.asScala.toSeq
          val headers = parser.getHeaderMap.asScala.keys.toSeq
          parser.close()
          (records, headers, delimiter)
        } match {
          case Success((records, originalHeaders, delimiter)) =>
            // Procesar cada registro del CSV
            val futureResults = Future.traverse(records) { record =>
              val fechaCompraStr = getColumnValue(record, Seq("Fecha Compra", "FechaCompra", "Fecha", "Date"))
              val concepto = getColumnValue(record, Seq("Concepto", "Descripcion", "Description"))
              val valorStr = getColumnValue(record, Seq("Valor", "Monto", "Amount", "Value"))
              val cuotasStr = getColumnValue(record, Seq("Cuotas", "Installments", "Numero Cuotas"))
              val tarjetaStr = getColumnValue(record, Seq("Tarjeta", "Card", "Tarjeta ID"))
              val interesStr = getColumnValue(record, Seq("Interes", "Interés", "Interest", "Tasa"))
              val descripcionStr = getColumnValue(record, Seq("descripcion", "Descripción", "Detalle", "Detail"))
              val estadoStr = getColumnValue(record, Seq("estado", "Estado", "Status"))

              // Validaciones
              if (concepto.isEmpty) {
                Future.successful((record, "Error: Concepto es obligatorio"))
              } else {
                // Parsear valor con soporte para decimales con coma
                parseDecimal(valorStr) match {
                  case Success(valor) if valor > 0 =>
                    // Parsear cuotas
                    Try(cuotasStr.toInt) match {
                      case Success(cuotas) if cuotas > 0 =>
                        if (tarjetaStr.isEmpty) {
                          Future.successful((record, "Error: Tarjeta es obligatoria"))
                        } else {
                          // Parsear interés con soporte para decimales con coma
                          parseDecimal(interesStr) match {
                            case Success(interes) =>
                              // Parsear fecha en múltiples formatos
                              val fechaCompra = parseFecha(fechaCompraStr).getOrElse(new Date())

                              // Buscar tarjeta por ID o franquicia
                              tarjetaRepositorio.findByIdOrFranquicia(tarjetaStr).flatMap {
                                case Some(tarjeta) =>
                                  // Crear la compra a crédito
                                  val compraCredito = CompraCredito(
                                    id = 0,
                                    fechaCreacion = null,
                                    concepto = concepto,
                                    valorCompra = valor,
                                    fechaCompra = fechaCompra,
                                    numeroCuotas = cuotas,
                                    fechaUltimaCuota = fechaCompra,
                                    pagoMensual = 0f,
                                    interes = interes,
                                    descripcion = descripcionStr,
                                    estado = if (estadoStr.isEmpty) "Pendiente" else estadoStr,
                                    tarjeta = tarjeta.id,
                                    responsables = "",
                                    porcentajePago = 0f
                                  )

                                  compraService.save(compraCredito).map { id =>
                                    (record, s"Éxito: Compra creada con ID $id")
                                  }.recover {
                                    case ex: Exception => (record, s"Error: ${ex.getMessage}")
                                  }
                                case None =>
                                  Future.successful((record, s"Error: Tarjeta '$tarjetaStr' no encontrada"))
                              }
                            case Failure(_) =>
                              Future.successful((record, s"Error: Interés inválido '$interesStr'"))
                          }
                        }
                      case Success(_) =>
                        Future.successful((record, s"Error: Cuotas debe ser mayor a 0"))
                      case Failure(_) =>
                        Future.successful((record, s"Error: Cuotas inválido '$cuotasStr'"))
                    }
                  case Success(_) =>
                    Future.successful((record, s"Error: Valor debe ser mayor a 0"))
                  case Failure(_) =>
                    Future.successful((record, s"Error: Valor inválido '$valorStr'"))
                }
              }
            }

            // Una vez procesados todos los registros, generar el CSV de respuesta
            futureResults.map { results =>
              val stringWriter = new StringWriter()

              // Capitalizar los encabezados originales
              val capitalizedHeaders = originalHeaders.map { header =>
                header.split("\\s+").map(_.capitalize).mkString(" ")
              } :+ "Resultado"

              val csvFormat = CSVFormat.DEFAULT
                .withDelimiter(delimiter)
                .withHeader(capitalizedHeaders: _*)

              val csvPrinter = new CSVPrinter(stringWriter, csvFormat)

              results.foreach { case (record, resultado) =>
                val values = originalHeaders.map { header =>
                  Try(record.get(header)).getOrElse("")
                } :+ resultado

                csvPrinter.printRecord(values.asJava)
              }

              csvPrinter.flush()
              csvPrinter.close()

              val csvContent = stringWriter.toString
              val exitosos = results.count(_._2.startsWith("Éxito"))
              val errores = results.count(_._2.startsWith("Error"))

              Ok(csvContent)
                .withHeaders(
                  "Content-Disposition" -> "attachment; filename=resultado_compras.csv",
                  "Content-Type" -> "text/csv; charset=utf-8"
                )
                .as("text/csv")
            }.recover {
              case ex: Exception =>
                InternalServerError(Json.obj("message" -> s"Error al procesar CSV: ${ex.getMessage}"))
            }

          case Failure(ex) =>
            Future.successful(BadRequest(Json.obj("message" -> s"Error al leer el archivo CSV: ${ex.getMessage}")))
        }
      case None =>
        Future.successful(BadRequest(Json.obj("message" -> "No se encontró el archivo en la solicitud")))
    }
  }

}