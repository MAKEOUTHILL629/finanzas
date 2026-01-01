package percistencia

import modelo.Persona
import play.api.db.Database

import javax.inject.Inject
import scala.concurrent.Future

class PersonaRepositorio  @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

  def list(): Future[Seq[Persona]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery("SELECT id,created_at,nombre, iniciales_nombre, color_representativo  FROM public.\"Personas\" ")
      var personas = Seq.empty[Persona]
      while (resultSet.next()) {
        personas = personas :+ Persona(resultSet.getInt("id"), resultSet.getString("nombre"), resultSet.getDate("created_at"), resultSet.getString("iniciales_nombre"), resultSet.getString("color_representativo"))
      }

      resultSet.close()
      statement.close()


      personas
    }
  }(databaseExecutionContext)
}