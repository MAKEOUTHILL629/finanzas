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
}