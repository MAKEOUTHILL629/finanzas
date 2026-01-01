package percistencia

import modelo.Tarjeta
import play.api.db.Database

import javax.inject.Inject
import scala.concurrent.Future


class PagosRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

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
}