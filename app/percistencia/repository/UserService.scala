package percistencia.repository

import com.google.inject.ImplementedBy
import modelo.User
import percistencia.UserServiceImpl

import scala.concurrent.Future

@ImplementedBy(classOf[UserServiceImpl])
trait UserService {
  // Sigue siendo útil para el login con contraseña y para buscar si un email ya existe
  def findByEmail(email: String): Future[Option[User]]


  // **NUEVO:** Método clave para manejar usuarios de diferentes fuentes.
  // Busca por provider+providerUserId, si no, busca por email (para posible enlace),
  // si no, crea un nuevo usuario.
  def findOrCreateUser(
                        providerId: String, // Ej: "google", "facebook", "password" (para diferenciar)
                        providerUserId: String, // Ej: El ID único de Google/Facebook, o el email para el login con contraseña
                        email: String, // Email (usualmente disponible)
                        name: Option[String],
                        avatarUrl: Option[String]
                      ): Future[User]


  def createUser(
                  email: String,
                  passwordHash: Option[String], // Acepta el hash directamente
                  name: Option[String],
                  role: String
                ): Future[User] // Devuelve el usuario creado (con ID)


}