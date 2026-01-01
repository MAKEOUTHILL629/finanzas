//package servicios
//
//import modelo.CalculadoraAmortizacion.calcularAmortizacion
//import modelo.CompraCredito
//import percistencia.{CompraCreditoRepositorio, CuotaDetalleRepositorio}
//
//import java.time.{YearMonth, ZoneId}
//import java.util.Date
//import javax.inject.Inject
//import scala.concurrent.ExecutionContext.Implicits.global
//import scala.concurrent.{ExecutionContext, Future}
//
//
//
//class CompraCreditoServicio  @Inject()(compraCreditoRepositorio: CompraCreditoRepositorio, cuotaDetalleRepositorio: CuotaDetalleRepositorio) {
//
//
//  def save(compraCredito: CompraCredito): Future[Int] =   {
//
//    // Convertir java.util.Date a LocalDate
//    val fechaCompraLocal = compraCredito.fechaCompra.toInstant
//      .atZone(ZoneId.systemDefault())
//      .toLocalDate
//
//    // Determinar la fecha del primer pago
//    val fechaPrimerPago = if (fechaCompraLocal.getDayOfMonth < 15) {
//      // Si es antes del 15, el primer pago es este mes
//      YearMonth.from(fechaCompraLocal).atEndOfMonth()
//    } else {
//      // Si es después del 15, el primer pago es el próximo mes
//      YearMonth.from(fechaCompraLocal).plusMonths(1).atEndOfMonth()
//    }
//
//    // Calcular la fecha de la última cuota
//    val fechaUltimaCuota = fechaPrimerPago.plusMonths(compraCredito.numeroCuotas.toLong - 1)
//
//    // Calcular el pago mensual
//    val pagoMensualBase = compraCredito.valorCompra / compraCredito.numeroCuotas
//
//
//    val interesMensual = pagoMensualBase * (compraCredito.interes / 100)
//    val pagoMensualTotal = pagoMensualBase + interesMensual
//
//    // Crear una nueva instancia de CompraCredito con los valores calculados
//    compraCredito.copy(
//      fechaUltimaCuota = java.sql.Date.valueOf(fechaUltimaCuota),
//      pagoMensual = pagoMensualTotal
//    )
//
//
//    val id = compraCreditoRepositorio.save(compraCredito.copy(
//      fechaUltimaCuota = java.sql.Date.valueOf(fechaUltimaCuota),
//      pagoMensual = pagoMensualTotal
//    ))
//
//    var ultimaCuotaLista = Date.from(fechaUltimaCuota.atStartOfDay(ZoneId.systemDefault()).toInstant);
//
//    id.map(id =>  {
//      val amortizacion = calcularAmortizacion(compraCredito.valorCompra, compraCredito.interes, compraCredito.numeroCuotas, compraCredito.fechaCompra)
//
//      amortizacion.foreach(cuota =>{
//
//        cuotaDetalleRepositorio.save(cuota.copy(compra = id));
//      })
//
//      amortizacion.lastOption.foreach(cuota => {
//        ultimaCuotaLista = cuota.fechaPago;
//      })
//
//
//    })
//
//
//
//
//
//    id
//  }
//
//
//
//  def recalcularCuotas(compraCredito: CompraCredito): Future[Int] = {
//
//
//    val amortizacion = calcularAmortizacion(compraCredito.valorCompra, compraCredito.interes, compraCredito.numeroCuotas, compraCredito.fechaCompra)
//    var ultimaCuota = compraCredito.fechaUltimaCuota;
//
//    amortizacion.find(_.numeroCuota == compraCredito.numeroCuotas).foreach(cuota => {
//
//      ultimaCuota = cuota.fechaPago;
//    })
//
//    for {
//      _ <- cuotaDetalleRepositorio.deleteByCompra(compraCredito.id)
//      _ <- cuotaDetalleRepositorio.saveBatch(amortizacion.map(_.copy(compra = compraCredito.id)))
//      updateResult <- compraCreditoRepositorio.update(compraCredito.copy(fechaUltimaCuota = ultimaCuota))
//    } yield {
//
//      updateResult
//    }
//  }
//
//
//  def cambioEstado(compraCredito: CompraCredito) = {
//    compraCreditoRepositorio.listByEstadoPendiente().map(compras => {
//
//      compras.foreach(compra => {
//        if(compra.fechaUltimaCuota.before(new java.util.Date())) {
//
//          compraCreditoRepositorio.update(compra.copy(estado = "Pagado"));
//        }
//      })
//
//    })
//
//
//  }
//
//  def ajusteInteresTarjetaCredito(tarjetaId: Int): Unit = {
//
//    compraCreditoRepositorio.listByEstadoPendienteTarjeta(tarjetaId).map(compras => {
//      compras.foreach(compra => {
//        val amortizacion = calcularAmortizacion(compra.valorCompra, compra.interes, compra.numeroCuotas, compra.fechaCompra)
//        cuotaDetalleRepositorio.deleteByCompra(compra.id).map(_ => {
//          amortizacion.foreach(cuota => {
//            cuotaDetalleRepositorio.save(cuota.copy(compra = compra.id))
//          })
//        })
//      })
//    })
//
//  }
//
//}
//
//


package servicios
import modelo.CalculadoraAmortizacion.calcularAmortizacion

import java.time.{LocalDate, YearMonth, ZoneId}
import java.util.Date
import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}
import modelo.CompraCredito
import percistencia.{CompraCreditoRepositorio, CuotaDetalleRepositorio, DatabaseExecutionContext}

class CompraCreditoServicio @Inject()(
                                       compraCreditoRepositorio: CompraCreditoRepositorio,
                                       cuotaDetalleRepositorio: CuotaDetalleRepositorio,
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
}

