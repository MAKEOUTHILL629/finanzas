package percistencia

import modelo.User
import percistencia.repository.UserService

import javax.inject._
import scala.concurrent.{ExecutionContext, Future}
import scala.util.{Success, Failure}

@Singleton
class UserServiceImpl @Inject()(implicit ec: ExecutionContext, userRepositoriy: UserRepositoriy) extends UserService {


  override def findByEmail(email: String): Future[Option[User]] = {
    println(s"Buscando usuario por email: $email")
    userRepositoriy.findByEmail(email)
  }

  override def findOrCreateUser(
                                 providerId: String,
                                 providerUserId: String,
                                 email: String,
                                 name: Option[String],
                                 avatarUrl: Option[String]
                               ): Future[User] = Future {
    println(s"FindOrCreate: Provider=$providerId, ProviderUserId=$providerUserId, Email=$email")

    // Lógica simplificada (DEBERÍAS IMPLEMENTARLA MEJOR):
    // 1. Buscar por providerId y providerUserId (si tuvieras una tabla LinkedAccount)
    //    val existingByProvider = findByProvider(providerId, providerUserId) // Método hipotético
    //    if (existingByProvider.isDefined) return existingByProvider.get

    // 2. Buscar por email para posible enlace automático (¡cuidado con la seguridad!)
    val existingByEmail = userRepositoriy.findByEmail(email).value.get.get

    existingByEmail match {
      case Some(user) =>
        println(s"Usuario encontrado por email ($email), ID: ${user.id}. Considerar enlace de cuenta.")
        // Aquí podrías añadir lógica para "enlazar" la cuenta social si aún no está enlazada.
        // Por ahora, solo devolvemos el usuario existente.
        // Podrías querer actualizar nombre/avatar si vienen del proveedor social.
        val updatedUser = user.copy(
          name = name.orElse(user.name),
          avatarUrl = avatarUrl.orElse(user.avatarUrl)
        )
        if(updatedUser != user) {
          userRepositoriy.updateByEmail(email, user)
          println("Usuario existente actualizado con datos del proveedor.")
        }
        updatedUser
      case None =>
        // 3. Crear nuevo usuario si no se encontró por email
        println(s"Usuario no encontrado, creando nuevo usuario para email: $email")
        val newUser = User(
          id = 1,
          email = email,
          passwordHash = None, // Sin contraseña local por defecto para nuevos usuarios sociales/OAuth
          role = "user", // Rol por defecto
          name = name,
          avatarUrl = avatarUrl,
          isActive = true
        )
        userRepositoriy.createUser(newUser)
        // Aquí también deberías crear la entrada en la tabla LinkedAccount si la tuvieras.
        newUser
    }
  }

  override def createUser(
                           email: String,
                           passwordHash: Option[String],
                           name: Option[String],
                           role: String
                         ): Future[User] = {
    println(s"Creando usuario: Email=$email, Name=$name, Role=$role, HasPassword=${passwordHash.isDefined}")
    userRepositoriy.findByEmail(email).flatMap {
      case Some(_) =>
        Future.failed(new Exception(s"User with email $email already exists (Service level check)."))
      case None =>
        val newUser = User(
          id = 1,
          email = email,
          passwordHash = passwordHash,
          role = role,
          name = name,
          avatarUrl = None,
          isActive = true
        )
        println("Llego aqui")
        userRepositoriy.createUser(newUser)
        println(s"Usuario creado con ID: ${newUser.id}")
        Future.successful(newUser)
    }
  }


}