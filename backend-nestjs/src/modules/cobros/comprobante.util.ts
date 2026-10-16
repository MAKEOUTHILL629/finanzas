import { datosInvalidos } from '../../common/utils/legacy-http.util';

/** Tope del archivo ya decodificado. El cuerpo JSON admite 4 MB y base64 pesa ~4/3, así que queda margen para el resto de campos. */
export const MAX_COMPROBANTE_BYTES = 2_400_000;

export const TIPOS_COMPROBANTE = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export interface ComprobanteValidado {
  nombre: string;
  tipo: string;
  tamano: number;
  datos: Buffer;
}

/** Firma («magic bytes») que debe tener el archivo según el tipo declarado: no se confía en el nombre ni en el tipo que dice el cliente. */
function coincideFirma(tipo: string, b: Buffer): boolean {
  switch (tipo) {
    case 'image/jpeg':
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf':
      return b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-';
    default:
      return false;
  }
}

export function nombreSeguro(nombre: string, tipo: string): string {
  const base = (nombre.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 120);
  if (base) return base;
  return tipo === 'application/pdf' ? 'comprobante.pdf' : 'comprobante';
}

/** Valida y decodifica un comprobante enviado en base64 (admite el prefijo `data:…;base64,`). Lanza 400 si algo no cuadra. */
export function validarComprobante(c: { nombre: string; tipo: string; datos: string }): ComprobanteValidado {
  if (!(TIPOS_COMPROBANTE as readonly string[]).includes(c.tipo)) {
    throw datosInvalidos({ comprobante: ['Solo se admiten imágenes JPG, PNG o WebP, o un PDF'] });
  }
  const crudo = c.datos.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  if (!crudo || !/^[A-Za-z0-9+/]+={0,2}$/.test(crudo)) throw datosInvalidos({ comprobante: ['El archivo no está en base64 válido'] });
  const datos = Buffer.from(crudo, 'base64');
  if (datos.length === 0) throw datosInvalidos({ comprobante: ['El archivo está vacío'] });
  if (datos.length > MAX_COMPROBANTE_BYTES) {
    throw datosInvalidos({ comprobante: [`El archivo pesa ${(datos.length / 1_000_000).toFixed(1)} MB y el máximo es ${(MAX_COMPROBANTE_BYTES / 1_000_000).toFixed(1)} MB`] });
  }
  if (!coincideFirma(c.tipo, datos)) throw datosInvalidos({ comprobante: ['El contenido del archivo no corresponde a su tipo'] });
  return { nombre: nombreSeguro(c.nombre, c.tipo), tipo: c.tipo, tamano: datos.length, datos };
}
