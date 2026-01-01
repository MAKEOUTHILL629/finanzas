package percistencia

import modelo.{CompraCredito, PagosMensualesReponsable, PagosMensualesResponsableDetalle}
import play.api.db.Database

import java.sql.{Connection, PreparedStatement, ResultSet, SQLException, Statement}
import java.util.Date
import javax.inject.{Inject, Singleton}
import scala.concurrent.{ExecutionContext, Future}


@Singleton
class ConsultaPagosMensuales @Inject()(
                                        db: Database,
                                        databaseExecutionContext: DatabaseExecutionContext
                                      )(implicit ec: ExecutionContext) {


  def listPagosMensualesPersona(): Future[Seq[PagosMensualesReponsable]] = Future {
    db.withConnection { conn =>
      val sql =
        """
         SELECT
    p.id AS persona_id,
    p.nombre,
     cd.fecha_pago AS mes_pago,
    SUM(cd.pago_total * (rc.porcentaje_pago / 100.0)) AS total_pago_responsable
FROM
    public."Personas" AS p
INNER JOIN
    public."ResponsablesComprasCredito" AS rc ON rc.persona = p.id
INNER JOIN
    public."ComprasCredito" AS cc ON cc.id = rc.compra_credito
INNER JOIN
    public."CuotasDetalle" AS cd ON cd.compra = cc.id
GROUP BY
    p.id, p.nombre, cd.fecha_pago
ORDER BY
    p.id, mes_pago;
        """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToPagoMensualPersona)
            .toList
        }
      }
    }
  }(databaseExecutionContext)


  private def mapResultSetToPagoMensualPersona(resultSet: ResultSet): PagosMensualesReponsable = {

    PagosMensualesReponsable(
      persona = resultSet.getInt("persona_id"),
      fecha = resultSet.getDate("mes_pago"),
      valorPago = resultSet.getFloat("total_pago_responsable"),

    )
  }

  def listPagosMensualesPersonaDetalle(idPersona: Int, mes: Int, year: Int): Future[Seq[PagosMensualesResponsableDetalle]] = Future {
    db.withConnection { conn =>
      val sql =
        s"""
         SELECT
    p.id AS persona_id,
    p.nombre,
    cc.id AS compra_credito_id,
    cc.concepto,
    rc.porcentaje_pago,
    rc.cantidad_pago,
    rc.cantidad_cuotas,
    cd.numero_cuota,
    cd.fecha_pago,
    cd.pago_total,
    cc.estado,
    cc.tarjeta,
    cd.saldo_restante * (rc.porcentaje_pago / 100.0) AS saldo_restante,
    cd.interes_pagado * (rc.porcentaje_pago / 100.0) AS interes_pagado,
    cd.aporte_capital * (rc.porcentaje_pago / 100.0) AS aporte_capital,
    cd.pago_total * (rc.porcentaje_pago / 100.0) AS monto_a_pagar_responsable
FROM
    public."Personas" AS p
INNER JOIN
    public."ResponsablesComprasCredito" AS rc ON rc.persona = p.id
INNER JOIN
    public."ComprasCredito" AS cc ON cc.id = rc.compra_credito
INNER JOIN
    public."CuotasDetalle" AS cd ON cd.compra = cc.id
WHERE
    p.id = $idPersona
    AND DATE_TRUNC('month', cd.fecha_pago) = DATE_TRUNC('month', '$year-$mes-01'::DATE)
    AND cc.concepto NOT LIKE '%Ajuste de Interes%'
ORDER BY
    p.id, cc.id, cd.fecha_pago;
        """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToPagoMensualPersonaDetalle)
            .toList
        }
      }
    }
  }(databaseExecutionContext)

  private def mapResultSetToPagoMensualPersonaDetalle(resultSet: ResultSet): PagosMensualesResponsableDetalle = {

    PagosMensualesResponsableDetalle(
      persona = resultSet.getInt("persona_id"),
      compraCredito = resultSet.getInt("compra_credito_id"),
      concepto = resultSet.getString("concepto"),
      porcentaje = resultSet.getFloat("porcentaje_pago"),
      cantidadCuotaTotal = resultSet.getInt("cantidad_cuotas"),
      numeroCuota = resultSet.getInt("numero_cuota"),
      fechaPago = resultSet.getDate("fecha_pago"),
      valorPagoCuota = resultSet.getFloat("pago_total"),
      valorPagoResponsable = resultSet.getFloat("monto_a_pagar_responsable"),
      tarjeta = resultSet.getInt("tarjeta"),
      estado = resultSet.getString("estado"),
      interesPagado = resultSet.getFloat("interes_pagado"),
      aporteCapital = resultSet.getFloat("aporte_capital"),
      saldoRestante = resultSet.getFloat("saldo_restante")

    )
  }

  private def using[A <: AutoCloseable, B](resource: A)(block: A => B): B =
    try {
      block(resource)
    } finally {
      if (resource != null) resource.close()
    }

}
