package modelo

import java.util.Date

case class Persona(id: Int, nombre: String, fechaCreacion: Date, inicialesNombre: String, colorRepresentativo: String)

case class User(
                 id: Long,
                 email: String,
                 passwordHash: Option[String],
                 role: String,

                 name: Option[String] = None,
                 avatarUrl: Option[String] = None,
                 isActive: Boolean ,
                 provider: String = "local", // Proveedor de autenticación (ej: "google", "facebook", "local")
                  providerUserId: Option[String] = None, // ID del usuario en el proveedor (ej: Google ID, Facebook ID)


               )
