package modelo

import java.util.Date


case class PagosMensualesReponsable(persona: Int, fecha: Date, valorPago: Float)

case class PagosMensualesResponsableDetalle(persona: Int, compraCredito: Int, concepto: String, porcentaje: Float,cantidadCuotaTotal: Int, numeroCuota:Int, fechaPago: Date, valorPagoCuota: Float, valorPagoResponsable: Float, tarjeta:Int, estado: String, interesPagado: Float, aporteCapital: Float, saldoRestante: Float)
