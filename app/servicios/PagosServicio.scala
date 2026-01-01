package servicios


import modelo.PagoCreditosMesTarjeta
import percistencia.{CompraCreditoRepositorio, CuotaDetalleRepositorio}

import java.text.SimpleDateFormat
import java.time.LocalDate

import java.util.Date
import javax.inject.Inject
import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.Future


class PagosServicio @Inject()(compraCreditoRepositorio: CompraCreditoRepositorio, cuotaDetalleRepositorio: CuotaDetalleRepositorio) {




//  def calcularPagoTarjetasCredito() = {
//    // Variable con mapa,
//
//
//    compraCreditoRepositorio.list().flatMap { compras =>
//      // Crear un mapa mutable para almacenar las sumatorias por tarjeta y fecha
//      val pagosMap = scala.collection.mutable.Map[(Int, Date), Float]()
//
//      // Procesar cada compra
//      Future.sequence(compras.map { compra =>
//        cuotaDetalleRepositorio.listByCompra(compra.id).map { cuotasDetalle =>
//          // Procesar cada cuota detalle
//          cuotasDetalle.foreach { cuota =>
//            val key = (compra.tarjeta, cuota.fechaPago) // Llave por tarjeta y fecha de pago
//            val valorActual = pagosMap.getOrElse(key, 0f) // Obtener el valor actual de la sumatoria
//            pagosMap.update(key, valorActual + cuota.pagoTotal) // Sumar el valor de la cuota
//          }
//        }
//      }).map { _ =>
//        // Convertir el mapa de sumatorias a la lista de PagoCreditosMesTarjeta
//        pagosMap.toList.map {
//          case ((tarjeta, fechaPago), valorPago) =>
//            PagoCreditosMesTarjeta(valorPago, tarjeta, fechaPago)
//        }
//      }
//    }
//
//  }


  def calcularPagoTarjetasCredito(): Future[List[PagoCreditosMesTarjeta]] = {
    // Fetch all CuotaDetalle joined with CompraCredito, excluding those with estado == "Ajuste Interes"
    cuotaDetalleRepositorio.listCuotasWithTarjeta().map { cuotasWithTarjeta =>
      // Aggregate payments by tarjeta and fechaPago
      val pagosMap = cuotasWithTarjeta.foldLeft(Map[(Int, Date), Float]()) { (map, tuple) =>
        val (cuota, tarjeta) = tuple
        val key = (tarjeta, cuota.fechaPago)
        val valorActual = map.getOrElse(key, 0f)
        map.updated(key, valorActual + cuota.pagoTotal)
      }
      // Convert the map to a list of PagoCreditosMesTarjeta
      pagosMap.toList.map {
        case ((tarjeta, fechaPago), valorPago) =>
          PagoCreditosMesTarjeta(valorPago, tarjeta, fechaPago)
      }
    }
  }


  def calcularPagoTarjetaCreditoDetalle(tarjeta: Int, year: Int, mes: Int) = {
    cuotaDetalleRepositorio.listCuotaWithTarjetaDetalle(tarjeta, year, mes).map { cuotas =>
      cuotas
    }
  }

  def pagarProductosTarjetaCredito()= {

    compraCreditoRepositorio.listByEstadoPendiente().flatMap { compras =>

      compras.foreach(compra => {

        // (compra.fechaUltimaCuota)
        val date1: LocalDate = LocalDate.parse(new SimpleDateFormat("yyyy-MM-dd").format(compra.fechaUltimaCuota))
        val date2: LocalDate = LocalDate.now()
        if(date1.isBefore(date2) || date1.isEqual(date2)){
          compraCreditoRepositorio.update( compra.copy(estado = "Pagado"))
        }
      })

      Future.successful(true)
    }

  }
}
