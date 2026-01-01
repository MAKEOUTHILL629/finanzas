//package percistencia
//
//import com.google.inject.Singleton
//import modelo.CalculadoraAmortizacion.CuotaDetalle
//import play.api.db.Database
//
//import java.sql.{SQLException, Statement}
//import java.util.concurrent.Executors
//import javax.inject.Inject
//import scala.concurrent.{ExecutionContext, Future}
//
//@Singleton
//case class CuotaDetalleRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {
//
//
//
//  def list(): Future[Seq[CuotaDetalle]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.createStatement
//      val resultSet = statement.executeQuery("SELECT id,numero_cuota,fecha_pago,saldo_restante,interes_pagado,aporte_capital,pago_total,compra,estado  FROM public.\"Tarjetas\" ")
//      var cuotasDetalle = Seq.empty[CuotaDetalle]
//      while (resultSet.next()) {
//        cuotasDetalle = cuotasDetalle :+ CuotaDetalle(resultSet.getInt("id"), resultSet.getInt("numero_cuota"),
//                                                      resultSet.getDate("fecha_pago"), resultSet.getFloat("saldo_restante"),
//                                                      resultSet.getFloat("interes_pagado"), resultSet.getFloat("aporte_capital"),
//                                                      resultSet.getFloat("pago_total"), resultSet.getInt("compra"), resultSet.getString("estado"))
//      }
//
//      resultSet.close()
//      statement.close()
//
//
//      cuotasDetalle
//    }
//  }(databaseExecutionContext)
//
//
//  def save(cuotaDetalle: CuotaDetalle): Future[Int] = Future {
//    db.withConnection { conn =>
//      val sql =
//        """
//        INSERT INTO public."CuotasDetalle" (
//          numero_cuota, fecha_pago, saldo_restante, interes_pagado, aporte_capital, pago_total, compra
//        ) VALUES (?, ?, ?, ?, ?, ?, ?)
//        """
//
//      val statement = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)
//      try {
//        statement.setInt(1, cuotaDetalle.numeroCuota)
//        statement.setDate(2, new java.sql.Date(cuotaDetalle.fechaPago.getTime))
//        statement.setFloat(3, cuotaDetalle.saldoRestante)
//        statement.setFloat(4, cuotaDetalle.interesPagado)
//        statement.setFloat(5, cuotaDetalle.aporteCapital)
//        statement.setFloat(6, cuotaDetalle.pagoTotal)
//        statement.setInt(7, cuotaDetalle.compra)
//
//        val affectedRows = statement.executeUpdate()
//
//        if (affectedRows == 0) {
//          throw new SQLException("Creating CuotaDetalle failed, no rows affected.")
//        }
//
//        val generatedKeys = statement.getGeneratedKeys
//        try {
//          if (generatedKeys.next()) {
//            generatedKeys.getInt(1)
//          } else {
//            throw new SQLException("Creating CuotaDetalle failed, no ID obtained.")
//          }
//        } finally {
//          generatedKeys.close()
//        }
//      } finally {
//        statement.close()
//      }
//    }
//  }(databaseExecutionContext)
//
//  val blockingExecutionContext = ExecutionContext.fromExecutor(Executors.newFixedThreadPool(1))
//
//  def listByCompra(compraId: Int): Future[Seq[CuotaDetalle]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.prepareStatement("SELECT id,numero_cuota,fecha_pago,saldo_restante,interes_pagado,aporte_capital,pago_total,compra,estado  FROM public.\"CuotasDetalle\" WHERE compra = ?")
//      try {
//        statement.setInt(1, compraId)
//        val resultSet = statement.executeQuery()
//        statement.closeOnCompletion()
//        try {
//          var cuotasDetalle = Seq.empty[CuotaDetalle]
//          while (resultSet.next()) {
//            cuotasDetalle = cuotasDetalle :+ CuotaDetalle(
//              resultSet.getInt("id"),
//              resultSet.getInt("numero_cuota"),
//              resultSet.getDate("fecha_pago"),
//              resultSet.getFloat("saldo_restante"),
//              resultSet.getFloat("interes_pagado"),
//              resultSet.getFloat("aporte_capital"),
//              resultSet.getFloat("pago_total"),
//              resultSet.getInt("compra"),
//              resultSet.getString("estado")
//            )
//          }
//          cuotasDetalle
//        } finally {
//          resultSet.close() // Cierra el ResultSet
//        }
//      } finally {
//        statement.close() // Cierra el PreparedStatement
//      }
//    }
//  }(blockingExecutionContext)
//
//
//
//  def saveBatch(cuotas: Seq[CuotaDetalle]): Future[Int] = Future {
//    db.withConnection { conn =>
//      val sql =
//        """
//        INSERT INTO public."CuotasDetalle" (
//          numero_cuota, fecha_pago, saldo_restante, interes_pagado, aporte_capital, pago_total, compra
//        ) VALUES (?, ?, ?, ?, ?, ?, ?)
//        """
//
//      val statement = conn.prepareStatement(sql)
//      try {
//        cuotas.foreach { cuota =>
//          statement.setInt(1, cuota.numeroCuota)
//          statement.setDate(2, new java.sql.Date(cuota.fechaPago.getTime))
//          statement.setFloat(3, cuota.saldoRestante)
//          statement.setFloat(4, cuota.interesPagado)
//          statement.setFloat(5, cuota.aporteCapital)
//          statement.setFloat(6, cuota.pagoTotal)
//          statement.setInt(7, cuota.compra)
//          statement.addBatch()
//        }
//        statement.executeBatch().sum
//      } finally {
//        statement.close()
//      }
//    }
//  }(databaseExecutionContext)
//
//  def deleteByCompra(compraId: Int): Future[Int] = Future {
//    db.withConnection { conn =>
//      val sql = "DELETE FROM public.\"CuotasDetalle\" WHERE compra = ?"
//      val statement = conn.prepareStatement(sql)
//      try {
//        statement.setInt(1, compraId)
//        statement.executeUpdate()
//      } finally {
//        statement.close()
//      }
//    }
//  }(databaseExecutionContext)
//}


package percistencia



import com.google.inject.Singleton
import modelo.CalculadoraAmortizacion.CuotaDetalle
import modelo.CuotaDetalleMes
import play.api.db.Database

import java.sql.{PreparedStatement, ResultSet, SQLException, Statement}
import javax.inject.Inject
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class CuotaDetalleRepositorio @Inject()(
                                         db: Database,
                                         databaseExecutionContext: DatabaseExecutionContext
                                       )(implicit ec: ExecutionContext) {

  def list(): Future[Seq[CuotaDetalle]] = Future {
    db.withConnection { conn =>
      val sql =
        """
        SELECT id, numero_cuota, fecha_pago, saldo_restante, interes_pagado,
               aporte_capital, pago_total, compra, estado
        FROM public."CuotasDetalle"
        """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToCuotaDetalle)
            .toList
        }
      }
    }
  }

  def save(cuotaDetalle: CuotaDetalle): Future[Int] = Future {
    db.withConnection { conn =>
      val sql =
        """
        INSERT INTO public."CuotasDetalle" (
          numero_cuota, fecha_pago, saldo_restante, interes_pagado,
          aporte_capital, pago_total, compra, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """
      using(conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) { statement =>
        setCuotaDetalleParameters(statement, cuotaDetalle)
        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new SQLException("Creating CuotaDetalle failed, no rows affected.")
        }
        using(statement.getGeneratedKeys) { generatedKeys =>
          if (generatedKeys.next()) generatedKeys.getInt(1)
          else throw new SQLException("Creating CuotaDetalle failed, no ID obtained.")
        }
      }
    }
  }

  def listByCompra(compraId: Int): Future[Seq[CuotaDetalle]] = Future {
    db.withConnection { conn =>
      val sql =
        """
        SELECT id, numero_cuota, fecha_pago, saldo_restante, interes_pagado,
               aporte_capital, pago_total, compra, estado
        FROM public."CuotasDetalle"
        WHERE compra = ?
        """
      using(conn.prepareStatement(sql)) { statement =>
        statement.setInt(1, compraId)
        using(statement.executeQuery()) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToCuotaDetalle)
            .toList
        }
      }
    }
  }

  def saveBatch(cuotas: Seq[CuotaDetalle]): Future[Int] = Future {
    db.withConnection { conn =>
      val sql =
        """
      INSERT INTO public."CuotasDetalle" (
        numero_cuota, fecha_pago, saldo_restante, interes_pagado,
        aporte_capital, pago_total, compra, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      """
      using(conn.prepareStatement(sql)) { statement =>
        cuotas.foreach { cuota =>
          setCuotaDetalleParameters(statement, cuota)
          statement.addBatch()
        }
        statement.executeBatch().sum
      }
    }
  }


  def deleteByCompra(compraId: Int): Future[Int] = Future {
    db.withConnection { conn =>
      val sql = "DELETE FROM public.\"CuotasDetalle\" WHERE compra = ?"
      using(conn.prepareStatement(sql)) { statement =>
        statement.setInt(1, compraId)
        statement.executeUpdate()
      }
    }
  }

  def findByCompra(compraId: Int): Future[Seq[CuotaDetalle]] = listByCompra(compraId)

  def update(cuotaDetalle: CuotaDetalle): Future[Int] = Future {
    db.withConnection { conn =>
      val sql =
        """
        UPDATE public."CuotasDetalle"
        SET numero_cuota = ?, fecha_pago = ?, saldo_restante = ?, interes_pagado = ?,
            aporte_capital = ?, pago_total = ?, compra = ?, estado = ?
        WHERE id = ?
        """
      using(conn.prepareStatement(sql)) { statement =>
        setCuotaDetalleParameters(statement, cuotaDetalle, isUpdate = true)
        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new SQLException("Updating CuotaDetalle failed, no rows affected.")
        }
        affectedRows
      }
    }
  }

  // Utility method to set parameters for PreparedStatement
  private def setCuotaDetalleParameters(
                                         statement: PreparedStatement,
                                         cuotaDetalle: CuotaDetalle,
                                         isUpdate: Boolean = false
                                       ): Unit = {
    statement.setInt(1, cuotaDetalle.numeroCuota)
    statement.setDate(2, new java.sql.Date(cuotaDetalle.fechaPago.getTime))
    statement.setFloat(3, cuotaDetalle.saldoRestante)
    statement.setFloat(4, cuotaDetalle.interesPagado)
    statement.setFloat(5, cuotaDetalle.aporteCapital)
    statement.setFloat(6, cuotaDetalle.pagoTotal)
    statement.setInt(7, cuotaDetalle.compra)
    statement.setString(8, cuotaDetalle.estado)
    if (isUpdate) {
      statement.setInt(9, cuotaDetalle.id)
    }
  }


  // Utility method to map a ResultSet to a CuotaDetalle object
  private def mapResultSetToCuotaDetalle(resultSet: ResultSet): CuotaDetalle = {
    CuotaDetalle(
      id = resultSet.getInt("id"),
      numeroCuota = resultSet.getInt("numero_cuota"),
      fechaPago = resultSet.getDate("fecha_pago"),
      saldoRestante = resultSet.getFloat("saldo_restante"),
      interesPagado = resultSet.getFloat("interes_pagado"),
      aporteCapital = resultSet.getFloat("aporte_capital"),
      pagoTotal = resultSet.getFloat("pago_total"),
      compra = resultSet.getInt("compra"),
      estado = resultSet.getString("estado")
    )
  }

  // Utility method for resource management
  private def using[A <: AutoCloseable, B](resource: A)(block: A => B): B =
    try {
      block(resource)
    } finally {
      if (resource != null) resource.close()
    }


  def listCuotasWithTarjeta(): Future[Seq[(CuotaDetalle, Int)]] = Future {
    db.withConnection { conn =>
      val sql = """
      SELECT cd.id, cd.numero_cuota, cd.fecha_pago, cd.saldo_restante, cd.interes_pagado,
             cd.aporte_capital, cd.pago_total, cd.compra, cd.estado,
             cc.tarjeta
      FROM public."CuotasDetalle" cd
      JOIN public."ComprasCredito" cc ON cd.compra = cc.id
      WHERE cd.estado != 'Ajuste Interes'
    """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map { rs =>
              val cuotaDetalle = mapResultSetToCuotaDetalle(rs)
              val tarjeta = rs.getInt("tarjeta")
              (cuotaDetalle, tarjeta)
            }
            .toList
        }
      }
    }
  }(databaseExecutionContext)

  def listCuotaWithTarjetaDetalle(tarjeta: Int, year: Int, mes: Int): Future[Seq[CuotaDetalleMes]] = Future {
    db.withConnection { conn =>
      val sql = s"""
      SELECT cd.id, cc.concepto, cd.numero_cuota,cc.numero_cuotas, cd.fecha_pago, cd.saldo_restante, cd.interes_pagado,
             cd.aporte_capital, cd.pago_total, cd.compra, cd.estado,
             cc.tarjeta
      FROM public."CuotasDetalle" cd
      JOIN public."ComprasCredito" cc ON cd.compra = cc.id
      WHERE cd.estado != 'Ajuste Interes'
      AND DATE_TRUNC('month', cd.fecha_pago) = DATE_TRUNC('month', '$year-$mes-01'::DATE)
      AND cc.tarjeta = $tarjeta
    """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map { rs =>
              val cuotaDetalle = mapResultSetToCuotaDetalle(rs)
              val tarjeta = rs.getInt("tarjeta")
              val concepto = rs.getString("concepto")
              val numeroCuotas = rs.getInt("numero_cuotas")
              CuotaDetalleMes(id= cuotaDetalle.id,
                              numeroCuota = cuotaDetalle.numeroCuota,
                              fechaPago = cuotaDetalle.fechaPago,
                              saldoRestante = cuotaDetalle.saldoRestante,
                              interesPagado = cuotaDetalle.interesPagado,
                              aporteCapital = cuotaDetalle.aporteCapital,
                              pagoTotal = cuotaDetalle.pagoTotal,
                              compra = cuotaDetalle.compra,
                              estado = cuotaDetalle.estado,
                              tarjeta = tarjeta,
                              concepto = concepto,
                              numeroCuotasTotal = numeroCuotas)
            }
            .toList
        }
      }
    }
  }(databaseExecutionContext)
}
