//package percistencia
//
//import com.google.inject.Singleton
//import modelo.{CompraCredito}
//import play.api.db.Database
//
//import java.sql.{SQLException, Statement}
//import javax.inject.Inject
//import scala.concurrent.Future
//
//@Singleton
//class CompraCreditoRepositorio  @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {
//
//  def list(): Future[Seq[CompraCredito]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.createStatement
//      val resultSet = statement.executeQuery("SELECT cc.id, cc.created_at,cc.concepto,cc.valor_compra,cc.fecha_compra, cc.numero_cuotas,cc.fecha_ultima_cuota, cc.pago_mensual,cc.interes,cc.descripcion,cc.estado,cc.tarjeta, array_to_string(array_agg(rcc.persona), ',') AS Responsables FROM public.\"ComprasCredito\" as cc LEFT JOIN public.\"ResponsablesComprasCredito\" rcc ON cc.id = rcc.compra_credito GROUP BY cc.id;")
//      var comprasCredito = Seq.empty[CompraCredito]
//      while (resultSet.next()) {
//        comprasCredito = comprasCredito :+ CompraCredito(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getString("concepto"), resultSet.getFloat("valor_compra"), resultSet.getDate("fecha_compra"), resultSet.getInt("numero_cuotas"), resultSet.getDate("fecha_ultima_cuota"), resultSet.getFloat("pago_mensual"), resultSet.getFloat("interes"), resultSet.getString("descripcion"), resultSet.getString("estado"), resultSet.getInt("tarjeta"), resultSet.getString("responsables"))
//      }
//
//      resultSet.close()
//      statement.close()
//
//
//      comprasCredito
//    }
//  }(databaseExecutionContext)
//
//  def get(id: Int): Future[Option[CompraCredito]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.prepareStatement("SELECT id,created_at,concepto,valor_compra,fecha_compra, numero_cuotas,fecha_ultima_cuota, pago_mensual,interes,descripcion,estado,tarjeta  FROM public.\"ComprasCredito\" WHERE id = ?")
//      statement.setInt(1, id)
//      val resultSet = statement.executeQuery()
//
//      val compraCredito = if (resultSet.next()) {
//        Some(CompraCredito(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getString("concepto"), resultSet.getFloat("valor_compra"), resultSet.getDate("fecha_compra"), resultSet.getInt("numero_cuotas"), resultSet.getDate("fecha_ultima_cuota"), resultSet.getFloat("pago_mensual"), resultSet.getFloat("interes"), resultSet.getString("descripcion"), resultSet.getString("estado"), resultSet.getInt("tarjeta"), "" )
//        )
//      } else {
//        None
//      }
//
//      resultSet.close()
//      statement.close()
//
//      compraCredito
//    }
//  }(databaseExecutionContext)
//
//  def update(compraCredito: CompraCredito): Future[Int] = Future {
//    db.withConnection { conn =>
//      val sql = """
//      UPDATE public."ComprasCredito"
//      SET concepto = ?, valor_compra = ?, fecha_compra = ?, numero_cuotas = ?,
//      fecha_ultima_cuota = ?, pago_mensual = ?, interes = ?, descripcion = ?, estado = ?, tarjeta = ?
//      WHERE id = ?
//    """
//
//      val statement = conn.prepareStatement(sql)
//
//      statement.setString(1, compraCredito.concepto)
//      statement.setFloat(2, compraCredito.valorCompra)
//      statement.setDate(3, new java.sql.Date(compraCredito.fechaCompra.getTime))
//      statement.setInt(4, compraCredito.numeroCuotas)
//      statement.setDate(5, new java.sql.Date(compraCredito.fechaUltimaCuota.getTime))
//      statement.setFloat(6, compraCredito.pagoMensual)
//      statement.setFloat(7, compraCredito.interes)
//      statement.setString(8, compraCredito.descripcion)
//      statement.setString(9, compraCredito.estado)
//      statement.setInt(10, compraCredito.tarjeta)
//      statement.setInt(11, compraCredito.id)
//
//      val affectedRows = statement.executeUpdate()
//      if (affectedRows == 0) {
//        throw new SQLException("Creating CompraCredito failed, no rows affected.")
//      }
//      println(s"La fecha actualizada es ${compraCredito.fechaUltimaCuota}")
//      //Aqui quiero imprimir lo que se inserto en base de datos
//      println("Se inserto en base de datos: " + affectedRows)
//      statement.close()
//
//      affectedRows
//    }
//  }(databaseExecutionContext)
//
//
//
//  def save(compraCredito: CompraCredito): Future[Int] = Future {
//    db.withConnection { conn =>
//      val sql = """
//      INSERT INTO public."ComprasCredito" (
//        concepto, valor_compra, fecha_compra, numero_cuotas,
//        fecha_ultima_cuota, pago_mensual, interes, descripcion, estado, tarjeta
//      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//    """
//
//      val statement = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)
//
//      statement.setString(1, compraCredito.concepto)
//      statement.setFloat(2, compraCredito.valorCompra)
//      statement.setDate(3, new java.sql.Date(compraCredito.fechaCompra.getTime))
//      statement.setInt(4, compraCredito.numeroCuotas)
//      statement.setDate(5, new java.sql.Date(compraCredito.fechaUltimaCuota.getTime))
//      statement.setFloat(6, compraCredito.pagoMensual)
//      statement.setFloat(7, compraCredito.interes)
//      statement.setString(8, compraCredito.descripcion)
//      statement.setString(9, compraCredito.estado)
//      statement.setInt(10, compraCredito.tarjeta)
//
//
//      val affectedRows = statement.executeUpdate()
//
//      if (affectedRows == 0) {
//        throw new SQLException("Creating CompraCredito failed, no rows affected.")
//      }
//
//      val generatedKeys = statement.getGeneratedKeys
//      var idOfInsertedRow: Int = 0
//      if (generatedKeys.next()) {
//        idOfInsertedRow = generatedKeys.getInt(1)
//      } else {
//        throw new SQLException("Creating CompraCredito failed, no ID obtained.")
//      }
//
//      generatedKeys.close()
//      statement.close()
//
//      idOfInsertedRow
//    }
//  }(databaseExecutionContext)
//
//  def listByEstadoPendiente(): Future[Seq[CompraCredito]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.createStatement
//      val resultSet = statement.executeQuery("SELECT id,created_at,concepto,valor_compra,fecha_compra, numero_cuotas,fecha_ultima_cuota, pago_mensual,interes,descripcion,estado,tarjeta  FROM public.\"ComprasCredito\" WHERE UPPER(estado) = 'PENDIENTE'")
//      var comprasCredito = Seq.empty[CompraCredito]
//      while (resultSet.next()) {
//        comprasCredito = comprasCredito :+ CompraCredito(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getString("concepto"), resultSet.getFloat("valor_compra"), resultSet.getDate("fecha_compra"), resultSet.getInt("numero_cuotas"), resultSet.getDate("fecha_ultima_cuota"), resultSet.getFloat("pago_mensual"), resultSet.getFloat("interes"), resultSet.getString("descripcion"), resultSet.getString("estado"), resultSet.getInt("tarjeta"), "")
//      }
//
//      resultSet.close()
//      statement.close()
//
//      comprasCredito
//
//    }
//  }(databaseExecutionContext)
//
//
//  def listByEstadoPendienteTarjeta(tarjeta: Int): Future[Seq[CompraCredito]] = Future {
//    db.withConnection { conn =>
//      val statement = conn.prepareStatement("SELECT id,created_at,concepto,valor_compra,fecha_compra, numero_cuotas,fecha_ultima_cuota, pago_mensual,interes,descripcion,estado,tarjeta  FROM public.\"ComprasCredito\" WHERE tarjeta = ? AND UPPER(estado) = 'PENDIENTE'")
//      statement.setInt(1, tarjeta)
//      val resultSet = statement.executeQuery()
//      var comprasCredito = Seq.empty[CompraCredito]
//      while (resultSet.next()) {
//        comprasCredito = comprasCredito :+ CompraCredito(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getString("concepto"), resultSet.getFloat("valor_compra"), resultSet.getDate("fecha_compra"), resultSet.getInt("numero_cuotas"), resultSet.getDate("fecha_ultima_cuota"), resultSet.getFloat("pago_mensual"), resultSet.getFloat("interes"), resultSet.getString("descripcion"), resultSet.getString("estado"), resultSet.getInt("tarjeta"), "")
//      }
//
//      resultSet.close()
//      statement.close()
//
//      comprasCredito
//    }
//  }(databaseExecutionContext)
//
//}

package percistencia
import modelo.CompraCredito

import play.api.db.Database

import java.sql.{Connection, PreparedStatement, ResultSet, SQLException, Statement}
import javax.inject.{Inject, Singleton}
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class CompraCreditoRepositorio @Inject()(
                                          db: Database,
                                          databaseExecutionContext: DatabaseExecutionContext
                                        )(implicit ec: ExecutionContext) {

  def list(): Future[Seq[CompraCredito]] = Future {
    db.withConnection { conn =>
      val sql =
        """
          SELECT cc.id, cc.created_at, cc.concepto, cc.valor_compra, cc.fecha_compra,
                 cc.numero_cuotas, cc.fecha_ultima_cuota, cc.pago_mensual, cc.interes,
                 cc.descripcion, cc.estado, cc.tarjeta,
                 array_to_string(array_agg(rcc.persona), ',') AS responsables,
                 SUM(rcc.porcentaje_pago) as porcentaje_pago
          FROM public."ComprasCredito" AS cc
          LEFT JOIN public."ResponsablesComprasCredito" rcc ON cc.id = rcc.compra_credito
          GROUP BY cc.id;
        """
      using(conn.createStatement()) { statement =>
        using(statement.executeQuery(sql)) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToCompraCredito)
            .toList
        }
      }
    }
  }(databaseExecutionContext)

  def get(id: Int): Future[Option[CompraCredito]] = Future {
    db.withConnection { conn =>
      val sql =
        """
          SELECT id, created_at, concepto, valor_compra, fecha_compra,
                 numero_cuotas, fecha_ultima_cuota, pago_mensual, interes,
                 descripcion, estado, tarjeta
          FROM public."ComprasCredito"
          WHERE id = ?
        """
      using(conn.prepareStatement(sql)) { statement =>
        statement.setInt(1, id)
        using(statement.executeQuery()) { resultSet =>
          if (resultSet.next()) Some(mapResultSetToCompraCredito(resultSet))
          else None
        }
      }
    }
  }(databaseExecutionContext)

  def update(compraCredito: CompraCredito): Future[Int] = Future {
    db.withConnection { conn =>
      val sql =
        """
          UPDATE public."ComprasCredito"
          SET concepto = ?, valor_compra = ?, fecha_compra = ?, numero_cuotas = ?,
              fecha_ultima_cuota = ?, pago_mensual = ?, interes = ?, descripcion = ?,
              estado = ?, tarjeta = ?
          WHERE id = ?
        """
      using(conn.prepareStatement(sql)) { statement =>
        setCompraCreditoParameters(statement, compraCredito, isUpdate = true)
        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new SQLException("Updating CompraCredito failed, no rows affected.")
        }
        affectedRows
      }
    }
  }(databaseExecutionContext)

  def save(compraCredito: CompraCredito): Future[Int] = Future {
    db.withConnection { conn =>
      val sql =
        """
          INSERT INTO public."ComprasCredito" (
            concepto, valor_compra, fecha_compra, numero_cuotas,
            fecha_ultima_cuota, pago_mensual, interes, descripcion, estado, tarjeta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
      using(conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) { statement =>
        setCompraCreditoParameters(statement, compraCredito)
        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new SQLException("Creating CompraCredito failed, no rows affected.")
        }
        using(statement.getGeneratedKeys) { generatedKeys =>
          if (generatedKeys.next()) generatedKeys.getInt(1)
          else throw new SQLException("Creating CompraCredito failed, no ID obtained.")
        }
      }
    }
  }(databaseExecutionContext)

  def listByEstadoPendiente(): Future[Seq[CompraCredito]] = {
    listByEstado("PENDIENTE")
  }

  def listByEstadoPendienteTarjeta(tarjeta: Int): Future[Seq[CompraCredito]] = {
    listByEstado("PENDIENTE", Some(tarjeta))
  }

  // Helper method to list purchases by estado and optional tarjeta
  private def listByEstado(estado: String, tarjeta: Option[Int] = None): Future[Seq[CompraCredito]] = Future {
    db.withConnection { conn =>
      val sql = new StringBuilder(
        """
          SELECT id, created_at, concepto, valor_compra, fecha_compra,
                 numero_cuotas, fecha_ultima_cuota, pago_mensual, interes,
                 descripcion, estado, tarjeta
          FROM public."ComprasCredito"
          WHERE UPPER(estado) = UPPER(?)
        """
      )
      tarjeta.foreach(_ => sql.append(" AND tarjeta = ?"))
      using(conn.prepareStatement(sql.toString())) { statement =>
        statement.setString(1, estado)
        tarjeta.foreach(t => statement.setInt(2, t))
        using(statement.executeQuery()) { resultSet =>
          Iterator
            .continually(resultSet)
            .takeWhile(_.next())
            .map(mapResultSetToCompraCredito)
            .toList
        }
      }
    }
  }(databaseExecutionContext)

  // Utility method to set parameters for PreparedStatement
  private def setCompraCreditoParameters(
                                          statement: PreparedStatement,
                                          compraCredito: CompraCredito,
                                          isUpdate: Boolean = false
                                        ): Unit = {
    statement.setString(1, compraCredito.concepto)
    statement.setFloat(2, compraCredito.valorCompra)
    statement.setDate(3, new java.sql.Date(compraCredito.fechaCompra.getTime))
    statement.setInt(4, compraCredito.numeroCuotas)
    statement.setDate(5, new java.sql.Date(compraCredito.fechaUltimaCuota.getTime))
    statement.setFloat(6, compraCredito.pagoMensual)
    statement.setFloat(7, compraCredito.interes)
    statement.setString(8, compraCredito.descripcion)
    statement.setString(9, compraCredito.estado)
    statement.setInt(10, compraCredito.tarjeta)
    if (isUpdate) {
      statement.setInt(11, compraCredito.id)
    }
  }

  def tieneColumna(rs: ResultSet, nombre: String): Boolean = {
    val meta = rs.getMetaData
    (1 to meta.getColumnCount).exists(i => meta.getColumnLabel(i).equalsIgnoreCase(nombre))
  }



  // Utility method to map a ResultSet to a CompraCredito object
  private def mapResultSetToCompraCredito(resultSet: ResultSet): CompraCredito = {
    val responsables = try {
      resultSet.getString("responsables")
    } catch {
      case _: SQLException => ""
    }

    val porcentajePago =
      if (tieneColumna(resultSet, "porcentaje_pago"))
        Option(resultSet.getObject("porcentaje_pago")).map(_.toString.toFloat)
      else
        None

    CompraCredito(
      id = resultSet.getInt("id"),
      fechaCreacion = resultSet.getDate("created_at"),
      concepto = resultSet.getString("concepto"),
      valorCompra = resultSet.getFloat("valor_compra"),
      fechaCompra = resultSet.getDate("fecha_compra"),
      numeroCuotas = resultSet.getInt("numero_cuotas"),
      fechaUltimaCuota = resultSet.getDate("fecha_ultima_cuota"),
      pagoMensual = resultSet.getFloat("pago_mensual"),
      interes = resultSet.getFloat("interes"),
      descripcion = resultSet.getString("descripcion"),
      estado = resultSet.getString("estado"),
      tarjeta = resultSet.getInt("tarjeta"),
      responsables = responsables,
      porcentajePago = porcentajePago.getOrElse(0f)
    )
  }

  // Utility method for resource management
  private def using[A <: AutoCloseable, B](resource: A)(block: A => B): B =
    try {
      block(resource)
    } finally {
      if (resource != null) resource.close()
    }
}
