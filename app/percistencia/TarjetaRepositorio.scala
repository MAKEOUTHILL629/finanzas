package percistencia

import modelo.Tarjeta

import javax.inject.Inject
import play.api.db.Database

import scala.concurrent.Future


class TarjetaRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

  def list(): Future[Seq[Tarjeta]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery("SELECT id,created_at,franquicia, descripcion  FROM public.\"Tarjetas\" ")
      var tarjetas = Seq.empty[Tarjeta]
      while (resultSet.next()) {
        tarjetas = tarjetas :+ Tarjeta(resultSet.getInt("id"), resultSet.getString("franquicia"), resultSet.getDate("created_at"), resultSet.getString("descripcion"))
      }

      resultSet.close()
      statement.close()


      tarjetas
    }
  }(databaseExecutionContext)

  def listBalance(mes: Int, year: Int) = Future {
    db.withConnection { conn =>
      val sql =
        s"""
         SELECT
cc.tarjeta,
t.franquicia,
    SUM(cd.saldo_restante) AS total_saldo_restante
FROM public."CuotasDetalle" cd
JOIN public."ComprasCredito" cc
    ON cd.compra = cc.id
JOIN public."Tarjetas" t
    ON cc.tarjeta = t.id
WHERE cd.estado = 'Pendiente'
  AND EXTRACT(MONTH FROM fecha_pago) = $mes
  AND EXTRACT(YEAR FROM fecha_pago) = $year
  GROUP BY cc.tarjeta, t.franquicia;
        """
      val statement = conn.createStatement
      val resultSet = statement.executeQuery(sql)
      var tarjetasBalance = Seq.empty[(Int, String, Double)]

      while (resultSet.next()) {
        tarjetasBalance = tarjetasBalance :+ (resultSet.getInt("tarjeta"), resultSet.getString("franquicia"), resultSet.getDouble("total_saldo_restante"))
      }

      resultSet.close()
      statement.close()

      tarjetasBalance

    }
  }(databaseExecutionContext)

  def findByIdOrFranquicia(identificador: String): Future[Option[Tarjeta]] = Future {
    db.withConnection { conn =>
      val sql =
        """
        SELECT id, created_at, franquicia, descripcion
        FROM public."Tarjetas"
        WHERE id::text = ? OR LOWER(franquicia) = LOWER(?)
        """
      val preparedStatement = conn.prepareStatement(sql)
      preparedStatement.setString(1, identificador)
      preparedStatement.setString(2, identificador)

      val resultSet = preparedStatement.executeQuery()

      val tarjeta = if (resultSet.next()) {
        Some(Tarjeta(
          resultSet.getInt("id"),
          resultSet.getString("franquicia"),
          resultSet.getDate("created_at"),
          resultSet.getString("descripcion")
        ))
      } else {
        None
      }

      resultSet.close()
      preparedStatement.close()

      tarjeta
    }
  }(databaseExecutionContext)

}