package percistencia

import modelo.{ ResponsableCompraCredito, Tarjeta}
import play.api.db.Database

import javax.inject.Inject
import scala.concurrent.Future


class ResponsablesCompraCreditoRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

  def list(): Future[Seq[ResponsableCompraCredito]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery("SELECT id,created_at,persona, porcentaje_pago, cantidad_pago,cantidad_cuotas, compra_credito  FROM public.\"ResponsablesComprasCredito\" ")
      var responsablesComprasCredito = Seq.empty[ResponsableCompraCredito]
      while (resultSet.next()) {
        responsablesComprasCredito = responsablesComprasCredito :+ ResponsableCompraCredito(resultSet.getInt("id"),  resultSet.getDate("created_at"), resultSet.getInt("persona"), resultSet.getInt("porcentaje_pago"), resultSet.getInt("cantidad_pago"), resultSet.getInt("cantidad_cuotas"), resultSet.getInt("compra_credito"))
      }

      resultSet.close()
      statement.close()


      responsablesComprasCredito
    }
  }(databaseExecutionContext)


  def listByCompraCredito(compraCredito: Int): Future[Seq[ResponsableCompraCredito]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery(s"SELECT id,created_at,persona, porcentaje_pago, cantidad_pago,cantidad_cuotas, compra_credito  FROM public.\"ResponsablesComprasCredito\" WHERE compra_credito = $compraCredito")
      var responsablesComprasCredito = Seq.empty[ResponsableCompraCredito]
      while (resultSet.next()) {
        responsablesComprasCredito = responsablesComprasCredito :+ ResponsableCompraCredito(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getInt("persona"), resultSet.getInt("porcentaje_pago"), resultSet.getInt("cantidad_pago"), resultSet.getInt("cantidad_cuotas"), resultSet.getInt("compra_credito"))
      }

      resultSet.close()
      statement.close()
      responsablesComprasCredito
    }
  }(databaseExecutionContext)


  def save(responsableCompraCredito: ResponsableCompraCredito): Future[ResponsableCompraCredito] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery(s"INSERT INTO public.\"ResponsablesComprasCredito\" (persona, porcentaje_pago, cantidad_pago,cantidad_cuotas, compra_credito) VALUES (${responsableCompraCredito.persona}, ${responsableCompraCredito.porcentajePago}, ${responsableCompraCredito.cantidadPago}, ${responsableCompraCredito.cantidadCuotas}, ${responsableCompraCredito.compraCredito}) RETURNING id")
      resultSet.next()
      val id = resultSet.getInt("id")
      responsableCompraCredito.copy(id = id)
    }
  }(databaseExecutionContext)

  def deleteByCompraCredito(compraCreditoId: Int): Future[Int] = Future {
    db.withConnection { conn =>
      val sql = "DELETE FROM public.\"ResponsablesComprasCredito\" WHERE compra_credito = ?"
      val statement = conn.prepareStatement(sql)
      try {
        statement.setInt(1, compraCreditoId)
        statement.executeUpdate()
      } finally {
        statement.close()
      }
    }
  }(databaseExecutionContext)

  def delete(id: Int): Future[Int] = Future {
    db.withConnection { conn =>
      val sql = "DELETE FROM public.\"ResponsablesComprasCredito\" WHERE id = ?"
      val statement = conn.prepareStatement(sql)
      try {
        statement.setInt(1, id)
        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new Exception(s"No se encontró el responsable con ID $id")
        }
        affectedRows
      } finally {
        statement.close()
      }
    }
  }(databaseExecutionContext)

  def update(responsable: ResponsableCompraCredito): Future[Int] = Future {
    db.withConnection { conn =>
      val sql = """
        UPDATE public."ResponsablesComprasCredito"
        SET persona = ?, porcentaje_pago = ?, cantidad_pago = ?, cantidad_cuotas = ?
        WHERE id = ?
      """
      val statement = conn.prepareStatement(sql)
      try {
        statement.setInt(1, responsable.persona)
        statement.setFloat(2, responsable.porcentajePago)
        statement.setFloat(3, responsable.cantidadPago)
        statement.setInt(4, responsable.cantidadCuotas)
        statement.setInt(5, responsable.id)

        val affectedRows = statement.executeUpdate()
        if (affectedRows == 0) {
          throw new Exception(s"No se encontró el responsable con ID ${responsable.id}")
        }
        affectedRows
      } finally {
        statement.close()
      }
    }
  }(databaseExecutionContext)
}