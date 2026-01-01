package modelo

import java.util.Date

case class Prestamo(id: Int, fechaCreacion: Date, valorPrestado: Float, concepto: String, fechaCobro:Date, responsable: Int, estado: String, comentarios: String)
