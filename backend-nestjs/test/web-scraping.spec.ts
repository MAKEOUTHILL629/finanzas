import axios from 'axios';
import { Decimal } from '../src/config/decimal.config';
import {
  normalizarDecimal,
  parseDecimalMoneda,
  parseDecimalTasa,
  parsearTasas,
  validarTasaInteres,
  WebScrapingService,
} from '../src/modules/tarjetas/web-scraping.service';

const d = (v: string) => new Decimal(v);

describe('normalizarDecimal (port exacto de WebScrapingServicio.scala)', () => {
  it.each([
    ['1.8895', '1.8895'], // punto decimal americano
    ['1,8895', '1.8895'], // coma decimal, 4 decimales (< 1000 antes de la coma)
    ['25,1852', '25.1852'],
    ['1,89', '1.89'],
    ['1,895', '1.895'],
    ['36.990', '36.990'], // solo punto → tal cual
    ['1.234,56', '1234.56'], // europeo con miles
    ['1,234.56', '1234.56'], // americano con miles
    ['1.234.567,89', '1234567.89'],
    ['36,990', '36.990'], // antes=36 < 1000 → se asume decimal
    ['1234,567', '1234567'], // antes >= 1000 → separador de miles
    ['100', '100'],
  ])('%s → %s', (entrada, esperado) => {
    expect(normalizarDecimal(entrada)).toBe(esperado);
  });
});

describe('parseDecimalTasa / parseDecimalMoneda', () => {
  it('extrae el número de textos con símbolos', () => {
    expect(parseDecimalTasa('1.8895%')?.toString()).toBe('1.8895');
    expect(parseDecimalTasa('25,1852 %')?.toString()).toBe('25.1852');
    expect(parseDecimalMoneda('$36,990')?.toString()).toBe('36.99');
    expect(parseDecimalMoneda('$36.990,00')?.toString()).toBe('36990');
  });

  it('sin dígitos o ilegible → null', () => {
    expect(parseDecimalTasa('N/A')).toBeNull();
    expect(parseDecimalTasa('1.2.3%')).toBeNull();
  });
});

describe('validarTasaInteres', () => {
  it('acepta (0, 100] y corrige valores mal escalados dividiendo por 10 hasta quedar ≤ 100', () => {
    expect(validarTasaInteres(d('1.8895'))?.toString()).toBe('1.8895');
    expect(validarTasaInteres(d('100'))?.toString()).toBe('100');
    // Igual que el algoritmo Scala (su comentario dice 1.8895, pero el bucle se detiene en el primer valor ≤ 100).
    expect(validarTasaInteres(d('18895'))?.toString()).toBe('18.895');
    expect(validarTasaInteres(d('251852'))?.toString()).toBe('25.1852');
  });

  it('rechaza ≤ 0, nulos y valores imposibles de corregir', () => {
    expect(validarTasaInteres(d('0'))).toBeNull();
    expect(validarTasaInteres(d('-3'))).toBeNull();
    expect(validarTasaInteres(null)).toBeNull();
    expect(validarTasaInteres(d('1e12'))).toBeNull();
  });
});

const HTML_BANCOLOMBIA = `
<html><body>
  <section id="tasas">
    <div class="valores-uno">
      <h3>Tasas de compra</h3>
      <div class="snippet-uno"><span class="precio-tasas">1,8895%</span><h4>Mensual vencida</h4></div>
      <div class="snippet-dos"><span class="precio-tasas">25,1852 %</span><h4>Efectivo anual</h4></div>
    </div>
    <div class="valores-uno">
      <h3>Tasas de avance</h3>
      <div class="snippet-uno"><span class="precio-tasas">2,0100%</span><h4>Mensual vencida</h4></div>
      <div class="snippet-dos"><span class="precio-tasas">27,0000%</span><h4>Efectivo anual</h4></div>
    </div>
  </section>
  <div class="calendario-plazo">Cuota de manejo $36,990 mensual</div>
</body></html>`;

describe('parsearTasas — estrategia Bancolombia', () => {
  const r = parsearTasas(HTML_BANCOLOMBIA, { id: 4, franquicia: 'Mastercard' });

  it('extrae compra/avance mensual y anual como Decimal exacto', () => {
    expect(r.exitoso).toBe(true);
    expect(r.tasaInteresCompraMensual?.toString()).toBe('1.8895');
    expect(r.tasaInteresCompraAnual?.toString()).toBe('25.1852');
    expect(r.tasaInteresAvanceMensual?.toString()).toBe('2.01');
    expect(r.tasaInteresAvanceAnual?.toString()).toBe('27');
    expect(r.mensaje).toContain('Scraping exitoso');
    expect(r.tarjetaId).toBe(4);
  });

  it('extrae la cuota de manejo del bloque .calendario-plazo', () => {
    expect(r.cuotaManejo?.toString()).toBe('36.99');
  });

  it('"$0" o "gratis" → cuota 0', () => {
    const html = '<div class="calendario-plazo">Cuota de manejo $0 primer año</div>';
    expect(parsearTasas(html, { id: 1, franquicia: 'X' }).cuotaManejo?.toString()).toBe('0');
  });
});

describe('parsearTasas — estrategia genérica', () => {
  it('clasifica por el contexto cercano (mensual/anual, compra/avance)', () => {
    // Cada tasa vive en su propio contenedor: la heurística lee el texto del padre y del abuelo del elemento.
    const html = `
      <ul>
        <li><div><p>Tasa de compra mensual</p><span>1,9500 %</span></div></li>
        <li><div><p>Tasa de avance mensual</p><span>2,2000 %</span></div></li>
        <li><div><p>Tasa de compra efectivo anual</p><span>26,1000 %</span></div></li>
      </ul>
      <p>Cuota de manejo mensual $12.500</p>`;
    const r = parsearTasas(html, { id: 9, franquicia: 'Visa' });
    expect(r.exitoso).toBe(true);
    expect(r.tasaInteresCompraMensual?.toString()).toBe('1.95');
    expect(r.tasaInteresAvanceMensual?.toString()).toBe('2.2');
    expect(r.tasaInteresCompraAnual?.toString()).toBe('26.1');
    expect(r.cuotaManejo?.toString()).toBe('12.5');
  });

  it('HTML sin tasas → exitoso=false con el mensaje legacy', () => {
    const r = parsearTasas('<html><body><p>Sin datos</p></body></html>', { id: 2, franquicia: 'Amex' });
    expect(r.exitoso).toBe(false);
    expect(r.mensaje).toContain('No se pudieron extraer tasas del HTML');
    expect(r.tasaInteresCompraMensual).toBeNull();
  });
});

describe('WebScrapingService', () => {
  const servicio = new WebScrapingService();
  const dias = (n: number) => new Date(Date.now() - n * 86_400_000 - 1000);

  it('necesitaActualizacion: nunca actualizada o ≥ 7 días', () => {
    expect(servicio.necesitaActualizacion({ ultimaActualizacionTasas: null })).toBe(true);
    expect(servicio.necesitaActualizacion({ ultimaActualizacionTasas: dias(7) })).toBe(true);
    expect(servicio.necesitaActualizacion({ ultimaActualizacionTasas: dias(3) })).toBe(false);
  });

  it('diasRestantes para el mensaje de las tarjetas OMITIDAS', () => {
    expect(servicio.diasRestantes({ ultimaActualizacionTasas: dias(3) })).toBe(4);
  });

  it('sin URL / URL inválida / protocolo no permitido → resultado fallido sin lanzar', async () => {
    const base = { id: 1, franquicia: 'X', ultimaActualizacionTasas: null };
    expect((await servicio.extraerTasas({ ...base, urlInfo: null })).mensaje).toBe('La tarjeta no tiene URL configurada');
    expect((await servicio.extraerTasas({ ...base, urlInfo: 'no-es-url' })).mensaje).toContain('URL inválida');
    expect((await servicio.extraerTasas({ ...base, urlInfo: 'file:///etc/passwd' })).mensaje).toContain('Protocolo no permitido');
  });

  it('descarga el HTML con User-Agent de navegador y lo parsea', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: HTML_BANCOLOMBIA });
    const r = await servicio.extraerTasas({
      id: 4,
      franquicia: 'Mastercard',
      urlInfo: 'https://www.bancolombia.com/tarjetas',
      ultimaActualizacionTasas: null,
    });
    expect(r.exitoso).toBe(true);
    const [url, opciones] = get.mock.calls[0];
    expect(url).toBe('https://www.bancolombia.com/tarjetas');
    expect((opciones as { headers: Record<string, string> }).headers['User-Agent']).toContain('Mozilla/5.0');
    expect((opciones as { timeout: number }).timeout).toBe(15000);
    get.mockRestore();
  });

  it('error HTTP → "Error HTTP <código>"; otros errores → "Error inesperado"', async () => {
    const get = jest.spyOn(axios, 'get');
    const base = { id: 1, franquicia: 'X', urlInfo: 'https://banco.test', ultimaActualizacionTasas: null };

    get.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 404'), { isAxiosError: true, response: { status: 404 } }));
    expect((await servicio.extraerTasas(base)).mensaje).toContain('Error HTTP 404');

    get.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));
    expect((await servicio.extraerTasas(base)).mensaje).toBe('Error inesperado: timeout of 15000ms exceeded');
    get.mockRestore();
  });
});
