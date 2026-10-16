/**
 * Limitador de ritmo en memoria (ventana deslizante) para endpoints públicos. Suficiente para una sola instancia: frena
 * ráfagas contra un enlace; no pretende reemplazar un WAF. Las claves viejas se purgan solas.
 */
export class LimiteTasa {
  private readonly intentos = new Map<string, number[]>();
  private ultimaLimpieza = Date.now();

  /** `true` si la petición cabe en `max` por `ventanaMs`; la cuenta solo si se permite. */
  permitir(clave: string, max: number, ventanaMs: number, ahora = Date.now()): boolean {
    this.limpiar(ahora, ventanaMs);
    const recientes = (this.intentos.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);
    if (recientes.length >= max) {
      this.intentos.set(clave, recientes);
      return false;
    }
    recientes.push(ahora);
    this.intentos.set(clave, recientes);
    return true;
  }

  private limpiar(ahora: number, ventanaMs: number): void {
    if (ahora - this.ultimaLimpieza < 60_000) return;
    this.ultimaLimpieza = ahora;
    for (const [clave, tiempos] of this.intentos) {
      if (tiempos.every((t) => ahora - t >= Math.max(ventanaMs, 3_600_000))) this.intentos.delete(clave);
    }
  }
}
