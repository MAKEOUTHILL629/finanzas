package modelo

import java.util.Date

case class Tarjeta(
  id: Int,
  franquicia: String,
  fechaCreacion: Date,
  descripcion: String,
  tasaInteresCompra: Option[Float] = None,
  tasaInteresAvance: Option[Float] = None,
  cuotaManejo: Option[Float] = None,
  urlInfo: Option[String] = None,
  ultimaActualizacionTasas: Option[Date] = None,
  extractTasas: Boolean = false
)
