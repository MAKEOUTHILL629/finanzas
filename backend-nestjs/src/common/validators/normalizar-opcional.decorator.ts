import { Transform } from 'class-transformer';

/**
 * Normaliza un campo OPCIONAL antes de validarlo: `''`, `null` y texto en blanco equivalen a «no enviado» (`undefined`).
 * Así un formulario que manda `cuentaId: ""` o `categoriaId: null` cuando no aplica no recibe un 400 ni crea una compra por error
 * (`dto.tarjetaId !== undefined` ya no se cumple con `null`).
 */
export const VacioAUndefined = (): PropertyDecorator =>
  Transform(({ value }) => (value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? undefined : value));

/**
 * Igual que `VacioAUndefined` y además convierte un entero escrito como texto ("12" → 12). Lo demás se deja tal cual para que
 * `@IsInt()` lo rechace con su mensaje (p. ej. "abc" o 1.5).
 */
export const EnteroOpcional = (): PropertyDecorator =>
  Transform(({ value }) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
      const t = value.trim();
      if (t === '') return undefined;
      return /^\d+$/.test(t) ? Number(t) : value;
    }
    return value;
  });
