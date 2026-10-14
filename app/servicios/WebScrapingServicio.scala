package servicios

import modelo.Tarjeta
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import play.api.Logger

import java.util.concurrent.TimeUnit
import javax.inject.{Inject, Singleton}
import scala.concurrent.{ExecutionContext, Future}
import scala.jdk.CollectionConverters._
import scala.util.Try

/** Resultado de scraping para una tarjeta */
case class ResultadoScrapingTarjeta(
  tarjetaId: Int,
  franquicia: String,
  tasaInteresCompraMensual: Option[Float],
  tasaInteresCompraAnual: Option[Float],
  tasaInteresAvanceMensual: Option[Float],
  tasaInteresAvanceAnual: Option[Float],
  cuotaManejo: Option[Float],
  exitoso: Boolean,
  mensaje: String
)

/** Estado de scraping por tarjeta */
sealed trait EstadoScraping
case object Actualizado    extends EstadoScraping
case object OmitidoReciente extends EstadoScraping  // ya fue actualizado esta semana
case object ErrorScraping  extends EstadoScraping

case class ResumenScraping(
  tarjetaId: Int,
  franquicia: String,
  estado: String,
  mensaje: String,
  resultado: Option[ResultadoScrapingTarjeta] = None
)

@Singleton
class WebScrapingServicio @Inject()(
  implicit ec: ExecutionContext
) {

  private val logger = Logger(getClass)

  /** Días mínimos entre actualizaciones (1 semana) */
  private val DIAS_MINIMOS_ENTRE_ACTUALIZACIONES = 7

  /** Tiempo de espera al conectar con el sitio (ms) */
  private val TIMEOUT_CONEXION_MS = 15000

  /**
   * Indica si la tarjeta necesita actualización:
   * - Si nunca se actualizó: sí
   * - Si la última actualización fue hace más de 7 días: sí
   */
  def necesitaActualizacion(tarjeta: Tarjeta): Boolean = {
    tarjeta.ultimaActualizacionTasas match {
      case None => true
      case Some(ultima) =>
        val ahora = System.currentTimeMillis()
        val diff = ahora - ultima.getTime
        val diasTranscurridos = TimeUnit.MILLISECONDS.toDays(diff)
        diasTranscurridos >= DIAS_MINIMOS_ENTRE_ACTUALIZACIONES
    }
  }

  /**
   * Realiza el scraping de tasas para una tarjeta.
   * Usa Jsoup con User-Agent para simular un navegador.
   */
  def extraerTasas(tarjeta: Tarjeta): Future[ResultadoScrapingTarjeta] = Future {
    tarjeta.urlInfo match {
      case None =>
        ResultadoScrapingTarjeta(
          tarjetaId = tarjeta.id,
          franquicia = tarjeta.franquicia,
          tasaInteresCompraMensual = None,
          tasaInteresCompraAnual = None,
          tasaInteresAvanceMensual = None,
          tasaInteresAvanceAnual = None,
          cuotaManejo = None,
          exitoso = false,
          mensaje = "La tarjeta no tiene URL configurada"
        )

      case Some(url) =>
        logger.info(s"Iniciando scraping para tarjeta ${tarjeta.id} (${tarjeta.franquicia}) - URL: $url")

        Try {
          val doc: Document = Jsoup.connect(url)
            .userAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept-Language", "es-CO,es;q=0.9")
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .timeout(TIMEOUT_CONEXION_MS)
            .get()

          parsearTasas(doc, tarjeta)

        }.recover {
          case e: org.jsoup.HttpStatusException =>
            logger.error(s"Error HTTP ${e.getStatusCode} al hacer scraping de ${url}: ${e.getMessage}")
            ResultadoScrapingTarjeta(
              tarjetaId = tarjeta.id,
              franquicia = tarjeta.franquicia,
              tasaInteresCompraMensual = None,
              tasaInteresCompraAnual = None,
              tasaInteresAvanceMensual = None,
              tasaInteresAvanceAnual = None,
              cuotaManejo = None,
              exitoso = false,
              mensaje = s"Error HTTP ${e.getStatusCode}: ${e.getMessage}"
            )
          case e: Exception =>
            logger.error(s"Error al hacer scraping de ${url}: ${e.getMessage}")
            ResultadoScrapingTarjeta(
              tarjetaId = tarjeta.id,
              franquicia = tarjeta.franquicia,
              tasaInteresCompraMensual = None,
              tasaInteresCompraAnual = None,
              tasaInteresAvanceMensual = None,
              tasaInteresAvanceAnual = None,
              cuotaManejo = None,
              exitoso = false,
              mensaje = s"Error inesperado: ${e.getMessage}"
            )
        }.get
    }
  }

  // ─── PARSING HTML ───────────────────────────────────────────────────────────

  /**
   * Parsea el documento HTML para extraer tasas.
   * Aplica múltiples estrategias en orden para cubrir diferentes layouts
   * de sitios bancarios.
   */
  private def parsearTasas(doc: Document, tarjeta: Tarjeta): ResultadoScrapingTarjeta = {

    // Estrategia 1: Buscar por la estructura de Bancolombia (.precio-tasas + h4)
    val (compM1, compA1, avM1, avA1) = extraerPorEstructuraBancolombia(doc)

    // Estrategia 2: Buscar por texto genérico con patrones comunes
    val (compM2, compA2, avM2, avA2) = if (compM1.isEmpty && compA1.isEmpty) {
      extraerPorTextoGenerico(doc)
    } else {
      (compM1, compA1, avM1, avA1)
    }

    val tasaCompraMensual  = compM2
    val tasaCompraAnual    = compA2
    val tasaAvanceMensual  = avM2
    val tasaAvanceAnual    = avA2
    val cuota              = extraerCuotaManejo(doc)

    val exitoso = tasaCompraMensual.isDefined || tasaCompraAnual.isDefined ||
                  tasaAvanceMensual.isDefined || cuota.isDefined

    val mensaje = if (exitoso)
      s"Scraping exitoso: compra mensual=${tasaCompraMensual.getOrElse("N/A")}%, " +
      s"compra anual=${tasaCompraAnual.getOrElse("N/A")}%, " +
      s"avance mensual=${tasaAvanceMensual.getOrElse("N/A")}%"
    else
      "No se pudieron extraer tasas del HTML. Puede que la página use JavaScript dinámico o haya cambiado su estructura."

    logger.info(s"[Tarjeta ${tarjeta.id}] $mensaje")

    ResultadoScrapingTarjeta(
      tarjetaId                = tarjeta.id,
      franquicia               = tarjeta.franquicia,
      tasaInteresCompraMensual = tasaCompraMensual,
      tasaInteresCompraAnual   = tasaCompraAnual,
      tasaInteresAvanceMensual = tasaAvanceMensual,
      tasaInteresAvanceAnual   = tasaAvanceAnual,
      cuotaManejo              = cuota,
      exitoso                  = exitoso,
      mensaje                  = mensaje
    )
  }

  /**
   * Estrategia Bancolombia:
   * Busca la sección #tasas → h3 con título → snippet con .precio-tasas y h4
   */
  private def extraerPorEstructuraBancolombia(doc: Document)
  : (Option[Float], Option[Float], Option[Float], Option[Float]) = {

    var compM: Option[Float] = None
    var compA: Option[Float] = None
    var avM:   Option[Float] = None
    var avA:   Option[Float] = None

    // Iterar por todos los bloques "valores-uno" dentro de #tasas
    val bloques = doc.select("#tasas .valores-uno").asScala

    bloques.foreach { bloque =>
      val tituloBloqueEl = bloque.select("h3").first()
      val tituloBloque   = if (tituloBloqueEl != null) tituloBloqueEl.text().toLowerCase else ""

      val esCompra  = tituloBloque.contains("compra") || tituloBloque.contains("impuesto")
      val esAvance  = tituloBloque.contains("avance")

      // Snippets del bloque: snippet-uno = mensual, snippet-dos = anual
      val snippets = bloque.select(".snippet-uno, .snippet-dos").asScala

      snippets.foreach { snippet =>
        val precioEl = snippet.select(".precio-tasas").first()
        val labelEl  = snippet.select("h4").first()

        if (precioEl != null && labelEl != null) {
          val texto = precioEl.text()
          val label = labelEl.text().toLowerCase
          // parseDecimal + validación de rango para tasas de interés (0–100%)
          val valor = parseDecimal(texto).flatMap(validarTasaInteres)

          if (esCompra) {
            if (label.contains("mensual"))        compM = valor.map(_.toFloat)
            else if (label.contains("anual"))     compA = valor.map(_.toFloat)
          } else if (esAvance) {
            if (label.contains("mensual"))        avM = valor.map(_.toFloat)
            else if (label.contains("anual"))     avA = valor.map(_.toFloat)
          }
        }
      }
    }

    (compM, compA, avM, avA)
  }

  /**
   * Estrategia genérica: busca patrones numéricos con % cerca de palabras clave.
   * Cubre otros bancos / layouts diferentes.
   */
  private def extraerPorTextoGenerico(doc: Document)
  : (Option[Float], Option[Float], Option[Float], Option[Float]) = {

    var compM: Option[Float] = None
    var compA: Option[Float] = None
    var avM:   Option[Float] = None
    var avA:   Option[Float] = None

    // Patrones: busca elementos que contengan % y estén cerca de palabras clave
    val porcentajes = doc.select("*:matchesOwn([0-9]+[.,][0-9]+\\s*%)").asScala

    porcentajes.foreach { el =>
      val texto  = el.text().toLowerCase
      val padre  = if (el.parent() != null) el.parent().text().toLowerCase else ""
      val abuelo = if (el.parent() != null && el.parent().parent() != null)
                     el.parent().parent().text().toLowerCase else ""

      val contexto = s"$texto $padre $abuelo"

      val valor = parseDecimal(el.ownText()).flatMap(validarTasaInteres).map(_.toFloat)

      if (valor.isDefined) {
        if (contexto.contains("mensual")) {
          if (contexto.contains("avance") && avM.isEmpty)       avM = valor
          else if (contexto.contains("compra") && compM.isEmpty) compM = valor
          else if (compM.isEmpty)                                compM = valor
        } else if (contexto.contains("anual") || contexto.contains("efectivo")) {
          if (contexto.contains("avance") && avA.isEmpty)       avA = valor
          else if (contexto.contains("compra") && compA.isEmpty) compA = valor
          else if (compA.isEmpty)                                compA = valor
        }
      }
    }

    (compM, compA, avM, avA)
  }

  /**
   * Extrae cuota de manejo del HTML.
   * Busca el elemento .calendario-plazo (Bancolombia) o patrones genéricos.
   */
  private def extraerCuotaManejo(doc: Document): Option[Float] = {
    // Estrategia 1: estructura Bancolombia
    val calendarioPlazo = doc.select(".calendario-plazo").first()
    if (calendarioPlazo != null) {
      val texto = calendarioPlazo.text()
      // Si dice "$0" o "0 meses" omitir, si tiene valor numérico extraer
      if (texto.contains("$0") || texto.toLowerCase.contains("gratis")) return Some(0f)
      val valor = parseDecimalMoneda(texto)
      if (valor.isDefined) return valor.map(_.toFloat)
    }

    // Estrategia 2: buscar por texto "cuota de manejo" o "fee"
    val elementos = doc.select("*:containsOwn(cuota de manejo), *:containsOwn(mantenimiento)").asScala
    elementos.flatMap { el =>
      val texto = el.text()
      parseDecimalMoneda(texto).map(_.toFloat)
    }.headOption
  }

  // ─── UTILS DE PARSING ───────────────────────────────────────────────────────

  /**
   * Parsea un string con porcentaje en diferentes formatos internacionales:
   * "1.8895%", "1,8895%", "25.1852 %", "25,1852%"
   */
  def parseDecimal(texto: String): Option[BigDecimal] = {
    val limpio = texto.replaceAll("[^0-9.,]", "").trim
    if (limpio.isEmpty) return None

    Try {
      val normalizado = normalizarDecimal(limpio)
      BigDecimal(normalizado)
    }.toOption
  }

  /**
   * Parsea un string con valor monetario:
   * "$36,990", "$36.990", "36990", "36.990,00"
   */
  def parseDecimalMoneda(texto: String): Option[BigDecimal] = {
    // Quitar símbolos de moneda y espacios
    val soloNumeros = texto.replaceAll("[^0-9.,]", "").trim
    if (soloNumeros.isEmpty) return None

    Try {
      val normalizado = normalizarDecimal(soloNumeros)
      BigDecimal(normalizado)
    }.toOption
  }

  /**
   * Normaliza un string numérico detectando si usa formato europeo o americano.
   *
   * Casos:
   *  "1.8895"   → punto decimal americano        → "1.8895"
   *  "1,8895"   → coma decimal 4 decimales       → "1.8895"  ✓ (fix: antes era "18895")
   *  "25,1852"  → coma decimal 4 decimales       → "25.1852" ✓ (fix: antes era "251852")
   *  "1,89"     → coma decimal 2 decimales       → "1.89"
   *  "1,895"    → coma decimal 3 decimales       → "1.895"
   *  "36.990"   → punto — devuelve tal cual      → "36.990"
   *  "1.234,56" → europeo con miles              → "1234.56"
   *  "1,234.56" → americano con miles            → "1234.56"
   *
   * Regla clave: solo coma + partes >= 3 dígitos → revisar número ANTES de la coma:
   *   - si < 1000 → se asume decimal (tasas de interés típicas < 100)
   *   - si >= 1000 → se asume separador de miles
   */
  private def normalizarDecimal(s: String): String = {
    val tienePunto = s.contains('.')
    val tieneComa  = s.contains(',')

    if (tienePunto && tieneComa) {
      // Ambos separadores: determinar cuál es el decimal por posición
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        // Europeo: "1.234,56" → "1234.56"
        s.replace(".", "").replace(",", ".")
      } else {
        // Americano: "1,234.56" → "123456" → wait, just remove commas
        s.replace(",", "")
      }
    } else if (tieneComa) {
      // Solo coma
      val idxComa           = s.lastIndexOf(',')
      val partesDespuesComa = s.length - idxComa - 1
      val antesStr          = s.substring(0, idxComa).replaceAll("[.,]", "")
      val antes             = Try(antesStr.toLong).getOrElse(0L)

      if (partesDespuesComa <= 2) {
        // 1-2 dígitos → siempre decimal: "1,89" → "1.89"
        s.replace(",", ".")
      } else {
        // 3 o más dígitos después de la coma:
        // Si el número ANTES de la coma es < 1000 → decimal
        //   "1,8895"  → antes=1   < 1000 → "1.8895"   ✓
        //   "25,1852" → antes=25  < 1000 → "25.1852"  ✓
        //   "1,895"   → antes=1   < 1000 → "1.895"    ✓
        //   "1,000"   → antes=1   < 1000 → "1.000"    (aceptable para tasa)
        // Si el número ANTES de la coma es >= 1000 → miles
        //   "1.000,00"→ ya cubierto por tienePunto && tieneComa
        if (antes < 1000) s.replace(",", ".")
        else              s.replace(",", "")
      }
    } else {
      // Solo punto o ningún separador → devolver tal cual
      // "1.8895" → "1.8895" ✓   "36.990" → "36.990" ✓
      s
    }
  }

  /**
   * Valida que una tasa de interés parseada sea razonable (0–100 %).
   * Si viene un valor como 18895 (resultado de un mal parseo),
   * intenta corregirlo dividiendo por potencias de 10 hasta quedar ≤ 100.
   * Si no se puede corregir de forma sensata, devuelve None.
   */
  private def validarTasaInteres(valor: BigDecimal): Option[BigDecimal] = {
    if (valor <= 0) return None
    if (valor <= 100) return Some(valor)

    // Intentar corregir: dividir por 10 sucesivamente hasta valor ≤ 100
    // Solo si la división produce un resultado con ≥ 1 decimal significativo
    // Máximo 6 divisiones (18895 / 10^4 = 1.8895)
    var corregido = valor
    var divisiones = 0
    while (corregido > 100 && divisiones < 6) {
      corregido = corregido / 10
      divisiones += 1
    }
    if (corregido > 0 && corregido <= 100) Some(corregido)
    else None
  }
}




