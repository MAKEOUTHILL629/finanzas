import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Decimal } from '../../config/decimal.config';
import { tryToDecimal } from '../../common/utils/decimal.util';

/** Resultado del scraping de una tarjeta (`ResultadoScrapingTarjeta` en Scala). Tasas como Decimal (Regla 1). */
export interface ResultadoScrapingTarjeta {
  tarjetaId: number;
  franquicia: string;
  tasaInteresCompraMensual: Decimal | null;
  tasaInteresCompraAnual: Decimal | null;
  tasaInteresAvanceMensual: Decimal | null;
  tasaInteresAvanceAnual: Decimal | null;
  cuotaManejo: Decimal | null;
  exitoso: boolean;
  mensaje: string;
}

export interface TarjetaScrapeable {
  id: number;
  franquicia: string;
  urlInfo: string | null;
  ultimaActualizacionTasas: Date | null;
}

type Tasas = {
  compM: Decimal | null;
  compA: Decimal | null;
  avM: Decimal | null;
  avA: Decimal | null;
};

const DIAS_MINIMOS_ENTRE_ACTUALIZACIONES = 7;
const TIMEOUT_CONEXION_MS = 15_000;
const MS_POR_DIA = 86_400_000;

// ─── Utilidades de parsing (port exacto de WebScrapingServicio.scala) ───────────────────────────────

/**
 * Normaliza un número en formato europeo o americano.
 *  "1,8895" → "1.8895" · "25,1852" → "25.1852" · "1.234,56" → "1234.56" · "1,234.56" → "1234.56" · "36.990" → "36.990"
 * Solo coma + ≥3 dígitos decimales: si lo anterior a la coma es < 1000 se asume decimal (tasas típicas < 100).
 */
export function normalizarDecimal(s: string): string {
  const tienePunto = s.includes('.');
  const tieneComa = s.includes(',');

  if (tienePunto && tieneComa) {
    return s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '');
  }
  if (tieneComa) {
    const idxComa = s.lastIndexOf(',');
    const digitosDespuesComa = s.length - idxComa - 1;
    const antes = Number.parseInt(s.substring(0, idxComa).replace(/[.,]/g, ''), 10);
    if (digitosDespuesComa <= 2) return s.replace(/,/g, '.');
    return (Number.isNaN(antes) ? 0 : antes) < 1000 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
  }
  return s;
}

/** "1.8895%", "1,8895%", "25.1852 %" → Decimal. */
export function parseDecimalTasa(texto: string): Decimal | null {
  const limpio = texto.replace(/[^0-9.,]/g, '').trim();
  if (!limpio) return null;
  return tryToDecimal(normalizarDecimal(limpio));
}

/** "$36,990", "$36.990", "36990", "36.990,00" → Decimal. */
export function parseDecimalMoneda(texto: string): Decimal | null {
  return parseDecimalTasa(texto);
}

/** Tasas válidas: (0, 100]. Valores mal parseados (18895) se dividen por 10 hasta quedar ≤ 100 (máx. 6 veces). */
export function validarTasaInteres(valor: Decimal | null): Decimal | null {
  if (!valor || !valor.greaterThan(0)) return null;
  if (valor.lessThanOrEqualTo(100)) return valor;
  let corregido = valor;
  let divisiones = 0;
  while (corregido.greaterThan(100) && divisiones < 6) {
    corregido = corregido.div(10);
    divisiones += 1;
  }
  return corregido.greaterThan(0) && corregido.lessThanOrEqualTo(100) ? corregido : null;
}

/** Equivalente a `Element.text()` de Jsoup: espacios normalizados. */
const normalizarTexto = (t: string) => t.replace(/\s+/g, ' ').trim();

type CheerioRoot = ReturnType<typeof cheerio.load>;

function ownText($: CheerioRoot, el: Parameters<CheerioRoot>[0]): string {
  return normalizarTexto(
    $(el)
      .contents()
      .filter((_, node) => node.type === 'text')
      .map((_, node) => (node as unknown as { data: string }).data)
      .get()
      .join(' '),
  );
}

/** Estrategia 1 — estructura de Bancolombia: `#tasas .valores-uno` → h3 + `.snippet-uno/.snippet-dos` (`.precio-tasas` + h4). */
function extraerPorEstructuraBancolombia($: CheerioRoot): Tasas {
  const out: Tasas = { compM: null, compA: null, avM: null, avA: null };

  $('#tasas .valores-uno').each((_, bloque) => {
    const tituloEl = $(bloque).find('h3').first();
    const titulo = tituloEl.length ? normalizarTexto(tituloEl.text()).toLowerCase() : '';
    const esCompra = titulo.includes('compra') || titulo.includes('impuesto');
    const esAvance = titulo.includes('avance');

    $(bloque)
      .find('.snippet-uno, .snippet-dos')
      .each((__, snippet) => {
        const precioEl = $(snippet).find('.precio-tasas').first();
        const labelEl = $(snippet).find('h4').first();
        if (!precioEl.length || !labelEl.length) return;

        const label = normalizarTexto(labelEl.text()).toLowerCase();
        const valor = validarTasaInteres(parseDecimalTasa(normalizarTexto(precioEl.text())));

        if (esCompra) {
          if (label.includes('mensual')) out.compM = valor;
          else if (label.includes('anual')) out.compA = valor;
        } else if (esAvance) {
          if (label.includes('mensual')) out.avM = valor;
          else if (label.includes('anual')) out.avA = valor;
        }
      });
  });

  return out;
}

/** Estrategia 2 — genérica: elementos cuyo texto propio contiene `n,nn %`, clasificados por el contexto cercano. */
function extraerPorTextoGenerico($: CheerioRoot): Tasas {
  const out: Tasas = { compM: null, compA: null, avM: null, avA: null };
  const patron = /[0-9]+[.,][0-9]+\s*%/;

  $('*').each((_, el) => {
    const propio = ownText($, el);
    if (!patron.test(propio)) return;

    const padre = $(el).parent();
    const abuelo = padre.parent();
    const texto = normalizarTexto($(el).text()).toLowerCase();
    const textoPadre = padre.length ? normalizarTexto(padre.text()).toLowerCase() : '';
    const textoAbuelo = abuelo.length ? normalizarTexto(abuelo.text()).toLowerCase() : '';
    const contexto = `${texto} ${textoPadre} ${textoAbuelo}`;

    const valor = validarTasaInteres(parseDecimalTasa(propio));
    if (!valor) return;

    if (contexto.includes('mensual')) {
      if (contexto.includes('avance') && !out.avM) out.avM = valor;
      else if (contexto.includes('compra') && !out.compM) out.compM = valor;
      else if (!out.compM) out.compM = valor;
    } else if (contexto.includes('anual') || contexto.includes('efectivo')) {
      if (contexto.includes('avance') && !out.avA) out.avA = valor;
      else if (contexto.includes('compra') && !out.compA) out.compA = valor;
      else if (!out.compA) out.compA = valor;
    }
  });

  return out;
}

function extraerCuotaManejo($: CheerioRoot): Decimal | null {
  const calendario = $('.calendario-plazo').first();
  if (calendario.length) {
    const texto = normalizarTexto(calendario.text());
    if (texto.includes('$0') || texto.toLowerCase().includes('gratis')) return new Decimal(0);
    const valor = parseDecimalMoneda(texto);
    if (valor) return valor;
  }

  let encontrada: Decimal | null = null;
  $('*').each((_, el) => {
    if (encontrada) return;
    const propio = ownText($, el).toLowerCase();
    if (propio.includes('cuota de manejo') || propio.includes('mantenimiento')) {
      encontrada = parseDecimalMoneda(normalizarTexto($(el).text()));
    }
  });
  return encontrada;
}

/** Parsea el HTML completo (estrategia Bancolombia con fallback genérico + cuota de manejo). */
export function parsearTasas(html: string, tarjeta: Pick<TarjetaScrapeable, 'id' | 'franquicia'>): ResultadoScrapingTarjeta {
  const $ = cheerio.load(html);
  const estructura = extraerPorEstructuraBancolombia($);
  const tasas = !estructura.compM && !estructura.compA ? extraerPorTextoGenerico($) : estructura;
  const cuota = extraerCuotaManejo($);

  const exitoso = Boolean(tasas.compM || tasas.compA || tasas.avM || cuota);
  const mensaje = exitoso
    ? `Scraping exitoso: compra mensual=${tasas.compM?.toString() ?? 'N/A'}%, ` +
      `compra anual=${tasas.compA?.toString() ?? 'N/A'}%, avance mensual=${tasas.avM?.toString() ?? 'N/A'}%`
    : 'No se pudieron extraer tasas del HTML. Puede que la página use JavaScript dinámico o haya cambiado su estructura.';

  return {
    tarjetaId: tarjeta.id,
    franquicia: tarjeta.franquicia,
    tasaInteresCompraMensual: tasas.compM,
    tasaInteresCompraAnual: tasas.compA,
    tasaInteresAvanceMensual: tasas.avM,
    tasaInteresAvanceAnual: tasas.avA,
    cuotaManejo: cuota,
    exitoso,
    mensaje,
  };
}

@Injectable()
export class WebScrapingService {
  private readonly logger = new Logger(WebScrapingService.name);

  /** Necesita actualización si nunca se actualizó o pasaron ≥ 7 días. */
  necesitaActualizacion(tarjeta: Pick<TarjetaScrapeable, 'ultimaActualizacionTasas'>, ahora: Date = new Date()): boolean {
    if (!tarjeta.ultimaActualizacionTasas) return true;
    const dias = Math.floor((ahora.getTime() - tarjeta.ultimaActualizacionTasas.getTime()) / MS_POR_DIA);
    return dias >= DIAS_MINIMOS_ENTRE_ACTUALIZACIONES;
  }

  /** Días que faltan para poder volver a actualizar (mensaje de las tarjetas OMITIDAS). */
  diasRestantes(tarjeta: Pick<TarjetaScrapeable, 'ultimaActualizacionTasas'>, ahora: Date = new Date()): number {
    if (!tarjeta.ultimaActualizacionTasas) return 0;
    const dias = Math.floor((ahora.getTime() - tarjeta.ultimaActualizacionTasas.getTime()) / MS_POR_DIA);
    return DIAS_MINIMOS_ENTRE_ACTUALIZACIONES - dias;
  }

  async extraerTasas(tarjeta: TarjetaScrapeable): Promise<ResultadoScrapingTarjeta> {
    const fallo = (mensaje: string): ResultadoScrapingTarjeta => ({
      tarjetaId: tarjeta.id,
      franquicia: tarjeta.franquicia,
      tasaInteresCompraMensual: null,
      tasaInteresCompraAnual: null,
      tasaInteresAvanceMensual: null,
      tasaInteresAvanceAnual: null,
      cuotaManejo: null,
      exitoso: false,
      mensaje,
    });

    if (!tarjeta.urlInfo) return fallo('La tarjeta no tiene URL configurada');

    let url: URL;
    try {
      url = new URL(tarjeta.urlInfo);
    } catch {
      return fallo(`URL inválida: ${tarjeta.urlInfo}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return fallo(`Protocolo no permitido: ${url.protocol}`);
    }

    this.logger.log(`Iniciando scraping para tarjeta ${tarjeta.id} (${tarjeta.franquicia}) - URL: ${url.href}`);
    try {
      const response = await axios.get<string>(url.href, {
        timeout: TIMEOUT_CONEXION_MS,
        responseType: 'text',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'es-CO,es;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const resultado = parsearTasas(String(response.data), tarjeta);
      this.logger.log(`[Tarjeta ${tarjeta.id}] ${resultado.mensaje}`);
      return resultado;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`Error HTTP ${error.response.status} al hacer scraping de ${url.href}: ${error.message}`);
        return fallo(`Error HTTP ${error.response.status}: ${error.message}`);
      }
      const mensaje = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error al hacer scraping de ${url.href}: ${mensaje}`);
      return fallo(`Error inesperado: ${mensaje}`);
    }
  }
}
