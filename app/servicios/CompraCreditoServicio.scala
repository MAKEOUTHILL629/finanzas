package servicios
import modelo.CalculadoraAmortizacion.calcularAmortizacion

import java.time.{LocalDate, YearMonth, ZoneId}
import java.util.Date
import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}
import modelo.CompraCredito
import percistencia.{CompraCreditoRepositorio, CuotaDetalleRepositorio, DatabaseExecutionContext, ResponsablesCompraCreditoRepositorio}

class CompraCreditoServicio @Inject()(
                                       compraCreditoRepositorio: CompraCreditoRepositorio,
                                       cuotaDetalleRepositorio: CuotaDetalleRepositorio,
                                       responsablesRepositorio: ResponsablesCompraCreditoRepositorio,
                                       databaseExecutionContext: DatabaseExecutionContext
                                     ) {

  implicit val ec: ExecutionContext = databaseExecutionContext

  def save(compraCredito: CompraCredito): Future[Int] = {
    val fechaCompraLocal = compraCredito.fechaCompra.toInstant
      .atZone(ZoneId.systemDefault())
      .toLocalDate

    val fechaPrimerPago = if (fechaCompraLocal.getDayOfMonth < 15) {
      YearMonth.from(fechaCompraLocal).atEndOfMonth()
    } else {
      YearMonth.from(fechaCompraLocal).plusMonths(1).atEndOfMonth()
    }

    val fechaUltimaCuota = fechaPrimerPago.plusMonths(compraCredito.numeroCuotas.toLong - 1)
    val pagoMensualBase = compraCredito.valorCompra / compraCredito.numeroCuotas
    val interesMensual = pagoMensualBase * (compraCredito.interes / 100)
    val pagoMensualTotal = pagoMensualBase + interesMensual

    val updatedCompraCredito = compraCredito.copy(
      fechaUltimaCuota = java.sql.Date.valueOf(fechaUltimaCuota),
      pagoMensual = pagoMensualTotal
    )

    for {
      id <- compraCreditoRepositorio.save(updatedCompraCredito)
      amortizacion = calcularAmortizacion(
        compraCredito.valorCompra,
        compraCredito.interes,
        compraCredito.numeroCuotas,
        compraCredito.fechaCompra,
        cobraInteresPrimeraCuota = false
      )
      _ <- Future.traverse(amortizacion) { cuota =>
        cuotaDetalleRepositorio.save(cuota.copy(compra = id))
      }
    } yield id
  }

  def recalcularCuotas(compraCredito: CompraCredito): Future[Int] = {
    var cobrarInteres = false;
    if(compraCredito.concepto.toUpperCase.contains("Ajuste de Interes".toUpperCase)){
      cobrarInteres = true;
    }
    val amortizacion = calcularAmortizacion(
      compraCredito.valorCompra,
      compraCredito.interes,
      compraCredito.numeroCuotas,
      compraCredito.fechaCompra,
      cobraInteresPrimeraCuota = cobrarInteres
    )

    val ultimaCuotaFecha = amortizacion
      .find(_.numeroCuota == compraCredito.numeroCuotas)
      .map(_.fechaPago)
      .getOrElse(compraCredito.fechaUltimaCuota)

    for {
      _ <- cuotaDetalleRepositorio.deleteByCompra(compraCredito.id)
      _ <- cuotaDetalleRepositorio.saveBatch(
        amortizacion.map(_.copy(compra = compraCredito.id))
      )
      updateResult <- compraCreditoRepositorio.update(
        compraCredito.copy(fechaUltimaCuota = ultimaCuotaFecha)
      )
    } yield updateResult
  }

  def cambioEstado(): Future[Unit] = {
    for {
      compras <- compraCreditoRepositorio.listByEstadoPendiente()
      _ <- Future.traverse(compras) { compra =>
        if (compra.fechaUltimaCuota.before(new Date())) {
          compraCreditoRepositorio.update(compra.copy(estado = "Pagado")).map(_ => ())
        } else {
          Future.unit
        }
      }
    } yield ()
  }

  def ajusteInteresTarjetaCredito(tarjetaId: Int): Future[Unit] = {
    val currentDate = LocalDate.now()
    for {
      compras <- compraCreditoRepositorio.listByEstadoPendienteTarjeta(tarjetaId)
      _ <- Future.traverse(compras) { compra =>
        val updatedCompra = compra.copy(estado = "Ajuste Interes")
        for {
          _ <- compraCreditoRepositorio.update(updatedCompra)
          amortizacion = calcularAmortizacion(
            compra.valorCompra,
            compra.interes,
            compra.numeroCuotas,
            compra.fechaCompra,
            cobraInteresPrimeraCuota = true // Interest charged on first installment
          )
          // Adjust the status of CuotaDetalle where fechaPago >= currentDate
          updatedAmortizacion = amortizacion.map { cuota =>
            val cuotaFechaPago = cuota.fechaPago.toInstant
              .atZone(ZoneId.systemDefault())
              .toLocalDate
            val newEstado =
              if (!cuotaFechaPago.isBefore(currentDate)) "Ajuste Interes"
              else cuota.estado
            cuota.copy(estado = newEstado)
          }
          _ <- cuotaDetalleRepositorio.deleteByCompra(compra.id)
          _ <- cuotaDetalleRepositorio.saveBatch(
            updatedAmortizacion.map(_.copy(compra = compra.id))
          )
        } yield ()
      }
    } yield ()
  }

  def delete(compraCreditoId: Int): Future[Unit] = {
    for {
      _ <- responsablesRepositorio.deleteByCompraCredito(compraCreditoId)
      _ <- cuotaDetalleRepositorio.deleteByCompra(compraCreditoId)
      _ <- compraCreditoRepositorio.delete(compraCreditoId)
    } yield ()
  }

  def updateCompra(compraCredito: CompraCredito): Future[Int] = {
    for {
      updateResult <- compraCreditoRepositorio.update(compraCredito)
      _ <- recalcularCuotas(compraCredito)
    } yield updateResult
  }
}

