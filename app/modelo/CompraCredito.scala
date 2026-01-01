package modelo

import java.util.Date

case class CompraCredito(id: Int, fechaCreacion: Date, concepto: String, valorCompra: Float, fechaCompra: Date,
                         numeroCuotas: Int, fechaUltimaCuota: Date, pagoMensual: Float, interes: Float, descripcion:String, estado: String, tarjeta: Int, responsables: String, porcentajePago: Float );

case class ResponsableCompraCredito(id: Int, fechaCreacion: Date, persona: Int, porcentajePago: Float, cantidadPago: Float, cantidadCuotas: Int, compraCredito: Int)



case class PagoCreditosMesTarjeta(valorPago: Float, tarjeta: Int, fechaPago: Date)
