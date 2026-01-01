

package modelo
import java.time.{Instant, LocalDate, YearMonth, ZoneId}
import java.util.Date

object CalculadoraAmortizacion {

  case class CuotaDetalle(
                           id: Int,
                           numeroCuota: Int,
                           fechaPago: Date,
                           saldoRestante: Float,
                           interesPagado: Float,
                           aporteCapital: Float,
                           pagoTotal: Float,
                           compra: Int,
                           estado: String
                         )

  def calcularAmortizacion(
                            valorCompra: Float,
                            interesMensual: Float,
                            numeroCuotas: Int,
                            fechaCompra: Date,
                            cobraInteresPrimeraCuota: Boolean
                          ): List[CuotaDetalle] = {

    def dateToLocalDate(date: Date): LocalDate = {
      if (date == null) {
        throw new IllegalArgumentException("Date cannot be null")
      }
      Instant.ofEpochMilli(date.getTime).atZone(ZoneId.systemDefault()).toLocalDate
    }

    def localDateToDate(localDate: LocalDate): Date =
      Date.from(localDate.atStartOfDay(ZoneId.systemDefault()).toInstant)

    def calcularFechaPrimeraCuota(fechaCompra: LocalDate): LocalDate = {
      val diaDelMes = fechaCompra.getDayOfMonth
      if (diaDelMes <= 15)
        YearMonth.from(fechaCompra).atEndOfMonth()
      else
        YearMonth.from(fechaCompra.plusMonths(1)).atEndOfMonth()
    }

    val valorCompraBD = BigDecimal(valorCompra.toDouble)
    val interesMensualBD = BigDecimal(interesMensual.toDouble) / 100 // Convertir a decimal
    val aporteCapitalFijo = valorCompraBD / numeroCuotas
    val fechaPrimeraCuota = calcularFechaPrimeraCuota(dateToLocalDate(fechaCompra))

    def calcularCuotas(
                        saldoRestante: BigDecimal,
                        numeroCuotaActual: Int,
                        fechaPago: LocalDate,
                        interesAcumulado: BigDecimal = BigDecimal(0)
                      ): List[CuotaDetalle] = {
      if (numeroCuotaActual > numeroCuotas) {
        Nil
      } else {
        val (interesPagado, nuevoInteresAcumulado) = if (numeroCuotaActual == 1) {
          if (cobraInteresPrimeraCuota) {
            (saldoRestante * interesMensualBD, BigDecimal(0))
          } else {
            (BigDecimal(0), saldoRestante * interesMensualBD)
          }
        } else {
          if (interesAcumulado > 0) {
            val interes = interesAcumulado + (saldoRestante * interesMensualBD)
            (interes, BigDecimal(0))
          } else {
            val interes = saldoRestante * interesMensualBD
            (interes, BigDecimal(0))
          }
        }

        val pagoTotal = aporteCapitalFijo + interesPagado
        val nuevoSaldo = saldoRestante - aporteCapitalFijo
        val estado = if (fechaPago.isBefore(LocalDate.now())) "Pagado" else "Pendiente"

        val cuotaDetalle = CuotaDetalle(
          id = 0,
          compra = 0,
          numeroCuota = numeroCuotaActual,
          fechaPago = localDateToDate(fechaPago),
          saldoRestante = nuevoSaldo.setScale(2, BigDecimal.RoundingMode.HALF_UP).toFloat,
          interesPagado = interesPagado.setScale(2, BigDecimal.RoundingMode.HALF_UP).toFloat,
          aporteCapital = aporteCapitalFijo.setScale(2, BigDecimal.RoundingMode.HALF_UP).toFloat,
          pagoTotal = pagoTotal.setScale(2, BigDecimal.RoundingMode.HALF_UP).toFloat,
          estado = estado
        )

        cuotaDetalle :: calcularCuotas(
          nuevoSaldo,
          numeroCuotaActual + 1,
          YearMonth.from(fechaPago.plusMonths(1)).atEndOfMonth(),
          nuevoInteresAcumulado
        )
      }
    }

    calcularCuotas(valorCompraBD, 1, fechaPrimeraCuota)
  }
}

case class CuotaDetalleMes(
                            id: Int,
                            numeroCuota: Int,
                            fechaPago: Date,
                            saldoRestante: Float,
                            interesPagado: Float,
                            aporteCapital: Float,
                            pagoTotal: Float,
                            compra: Int,
                            estado: String,
                            tarjeta: Int,
                            concepto: String,
                            numeroCuotasTotal: Int
                          )
