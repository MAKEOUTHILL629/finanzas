package percistencia

import modelo.User
import play.api.db.Database

import javax.inject.Inject
import scala.concurrent.Future

class UserRepositoriy @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext){

  def findByEmail(email: String): Future[Option[User]] = Future {
    db.withConnection { conn =>
      val statement = conn.prepareStatement("SELECT id, email, password_hash, role,name, avatar_url, is_active, provider, provider_user_id FROM public.\"Users\" WHERE email = ?")
      statement.setString(1, email)
      val resultSet = statement.executeQuery()
      if (resultSet.next()) {
        Some(
          User(
            id = resultSet.getLong("id"),
            email = resultSet.getString("email"),
            passwordHash = Option(resultSet.getString("password_hash")),
            role = resultSet.getString("role"),
            name = Option(resultSet.getString("name")),
            avatarUrl = Option(resultSet.getString("avatar_url")),
            isActive = resultSet.getBoolean("is_active"),
            provider = resultSet.getString("provider"),
            providerUserId = Option(resultSet.getString("provider_user_id"))
          )
        )
      } else {
        None
      }
    }
  }(databaseExecutionContext)

  def updateByEmail(email: String, user: User): Future[Int] = Future {
    db.withConnection { conn =>
      val statement = conn.prepareStatement(
        """
          |UPDATE public."Users"
          |SET email = ?, password_hash = ?, role = ?, name = ?, avatar_url = ?, is_active = ?, provider = ?, provider_user_id = ?
          |WHERE email = ?
        """.stripMargin
      )
      statement.setString(1, user.email)
      statement.setString(2, user.passwordHash.getOrElse(""))
      statement.setString(3, user.role)
      statement.setString(4, user.name.getOrElse(""))
      statement.setString(5, user.avatarUrl.getOrElse(""))
      statement.setBoolean(6, user.isActive)
      statement.setString(7, user.provider)
      statement.setString(8, user.providerUserId.getOrElse(""))
      statement.setString(9, email)
      statement.executeUpdate()
    }
  }(databaseExecutionContext)

  def createUser(user: User): Future[Long] = Future {
    db.withConnection { conn =>
      val statement = conn.prepareStatement(
        """
          |INSERT INTO public."Users" (email, password_hash, role, name, avatar_url, is_active, provider, provider_user_id)
          |VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          |RETURNING id
        """.stripMargin
      )
      statement.setString(1, user.email)
      statement.setString(2, user.passwordHash.getOrElse(""))
      statement.setString(3, user.role)
      statement.setString(4, user.name.getOrElse(""))
      statement.setString(5, user.avatarUrl.getOrElse(""))
      statement.setBoolean(6, user.isActive)
      statement.setString(7, user.provider)
      statement.setString(8, user.providerUserId.getOrElse(""))


      println(s"Executing SQL statement: ${statement.toString}")
      try {
        val resultSet = statement.executeQuery()
        if (resultSet.next()) {
          resultSet.getLong("id")
        } else {
          throw new RuntimeException("Failed to create user: No ID returned from insert")
        }
      } catch {
        case e: Exception =>
          println(s"Error executing SQL statement: ${e.getMessage}")
          throw new RuntimeException(s"Failed to create user: ${e.getMessage}", e)
      }
    }
  }(databaseExecutionContext)

}
