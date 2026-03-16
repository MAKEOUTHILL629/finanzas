package percistencia

import modelo.Tarjeta

import javax.inject.Inject
import play.api.db.Database

import scala.concurrent.Future


class TarjetaRepositorio @Inject()(db: Database, databaseExecutionContext: DatabaseExecutionContext) {

  private def mapearTarjeta(resultSet: java.sql.ResultSet): Tarjeta = {
    val ultimaAct = resultSet.getTimestamp("ultima_actualizacion_tasas")
    Tarjeta(
      id = resultSet.getInt("id"),
      franquicia = resultSet.getString("franquicia"),
      fechaCreacion = resultSet.getDate("created_at"),
      descripcion = resultSet.getString("descripcion"),
      tasaInteresCompra = {
        val v = resultSet.getFloat("tasa_interes_compra")
        if (resultSet.wasNull()) None else Some(v)
      },
      tasaInteresAvance = {
        val v = resultSet.getFloat("tasa_interes_avance")
        if (resultSet.wasNull()) None else Some(v)
      },
      cuotaManejo = {
        val v = resultSet.getFloat("cuota_manejo")
        if (resultSet.wasNull()) None else Some(v)
      },
      urlInfo = Option(resultSet.getString("url_info")),
      ultimaActualizacionTasas = Option(ultimaAct).map(ts => new java.util.Date(ts.getTime)),
      extractTasas = resultSet.getBoolean("extract_tasas")
    )
  }

  def list(): Future[Seq[Tarjeta]] = Future {
    db.withConnection { conn =>
      val statement = conn.createStatement
      val resultSet = statement.executeQuery(
        """SELECT id, created_at, franquicia, descripcion,
          |tasa_interes_compra, tasa_interes_avance, cuota_manejo,
          |url_info, ultima_actualizacion_tasas, extract_tasas
          |FROM public."Tarjetas"""".stripMargin
      )
      var tarjetas = Seq.empty[Tarjeta]
      while (resultSet.next()) {
        tarjetas = tarjetas :+ mapearTarjeta(resultSet)
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
        SELECT id, created_at, franquicia, descripcion,
          tasa_interes_compra, tasa_interes_avance, cuota_manejo,
          url_info, ultima_actualizacion_tasas, extract_tasas
        FROM public."Tarjetas"
        WHERE id::text = ? OR LOWER(franquicia) = LOWER(?)
        """
      val preparedStatement = conn.prepareStatement(sql)
      preparedStatement.setString(1, identificador)
      preparedStatement.setString(2, identificador)

      val resultSet = preparedStatement.executeQuery()

      val tarjeta = if (resultSet.next()) Some(mapearTarjeta(resultSet)) else None

      resultSet.close()
      preparedStatement.close()

      tarjeta
    }
  }(databaseExecutionContext)

  /** Obtiene todas las tarjetas con extract_tasas = true */
  def listParaScraping(): Future[Seq[Tarjeta]] = Future {
    db.withConnection { conn =>
      val sql =
        """SELECT id, created_at, franquicia, descripcion,
          |tasa_interes_compra, tasa_interes_avance, cuota_manejo,
          |url_info, ultima_actualizacion_tasas, extract_tasas
          |FROM public."Tarjetas"
          |WHERE extract_tasas = true AND url_info IS NOT NULL""".stripMargin
      val statement = conn.createStatement
      val resultSet = statement.executeQuery(sql)
      var tarjetas = Seq.empty[Tarjeta]
      while (resultSet.next()) {
        tarjetas = tarjetas :+ mapearTarjeta(resultSet)
      }
      resultSet.close()
      statement.close()
      tarjetas
    }
  }(databaseExecutionContext)

  /** Actualiza las tasas de interés de una tarjeta específica */
  def actualizarTasas(
    id: Int,
    tasaInteresCompra: Option[Float],
    tasaInteresAvance: Option[Float],
    cuotaManejo: Option[Float]
  ): Future[Boolean] = Future {
    db.withConnection { conn =>
      val sql =
        """UPDATE public."Tarjetas"
          |SET tasa_interes_compra = ?,
          |    tasa_interes_avance = ?,
          |    cuota_manejo = ?,
          |    ultima_actualizacion_tasas = NOW()
          |WHERE id = ?""".stripMargin
      val ps = conn.prepareStatement(sql)

      tasaInteresCompra match {
        case Some(v) => ps.setFloat(1, v)
        case None    => ps.setNull(1, java.sql.Types.REAL)
      }
      tasaInteresAvance match {
        case Some(v) => ps.setFloat(2, v)
        case None    => ps.setNull(2, java.sql.Types.REAL)
      }
      cuotaManejo match {
        case Some(v) => ps.setFloat(3, v)
        case None    => ps.setNull(3, java.sql.Types.REAL)
      }
      ps.setInt(4, id)

      val rows = ps.executeUpdate()
      ps.close()
      rows > 0
    }
  }(databaseExecutionContext)
}