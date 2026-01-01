package percistencia

import modelo.{Prestamo}
import play.api.db.Database

import javax.inject.Inject
import scala.concurrent.Future


class PrestamoRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

  def list(): Future[Seq[Prestamo]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery("SELECT id,created_at,valor_prestado, concepto, fecha_cobro, responsable, estado, comentarios  FROM public.\"Prestamos\" ")
      var prestamos = Seq.empty[Prestamo]
      while (resultSet.next()) {
        prestamos = prestamos :+ Prestamo(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getFloat("valor_prestado"), resultSet.getString("concepto"), resultSet.getDate("fecha_cobro"), resultSet.getInt("responsable"), resultSet.getString("estado"), resultSet.getString("comentarios"))
      }

      resultSet.close()
      statement.close()


      prestamos
    }
  }(databaseExecutionContext)

  def listByResponsable(id: Int): Future[Seq[Prestamo]] = Future {
    db.withConnection { conn =>
      val statement = conn.prepareStatement("SELECT id,created_at,valor_prestado, concepto, fecha_cobro, responsable, estado, comentarios  FROM public.\"Prestamos\" WHERE responsable = ?")
      statement.setInt(1, id)
      val resultSet = statement.executeQuery()
      var prestamos = Seq.empty[Prestamo]
      while (resultSet.next()) {
        prestamos = prestamos :+ Prestamo(resultSet.getInt("id"), resultSet.getDate("created_at"), resultSet.getFloat("valor_prestado"), resultSet.getString("concepto"), resultSet.getDate("fecha_cobro"), resultSet.getInt("responsable"), resultSet.getString("estado"), resultSet.getString("comentarios"))
      }

      resultSet.close()
      statement.close()

      prestamos
    }
  }(databaseExecutionContext)


  def save(prestamo: Prestamo): Future[Prestamo] = Future {
    db.withConnection { conn =>
      val statement = conn.prepareStatement("INSERT INTO public.\"Prestamos\" ( valor_prestado, concepto, fecha_cobro, responsable, estado, comentarios) VALUES (?,?,?,?,?,?) RETURNING id")
      statement.setFloat(1, prestamo.valorPrestado)
      statement.setString(2, prestamo.concepto)
      statement.setDate(3, new java.sql.Date(prestamo.fechaCobro.getTime))
      statement.setInt(4, prestamo.responsable)
      statement.setString(5, prestamo.estado)
      statement.setString(6, prestamo.comentarios)
      val resultSet = statement.executeQuery()
      resultSet.next()
      val id = resultSet.getInt("id")
      prestamo.copy(id = id)
    }
  }(databaseExecutionContext)


}