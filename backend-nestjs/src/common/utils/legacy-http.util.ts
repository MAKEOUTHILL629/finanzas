import { HttpException, HttpStatus } from '@nestjs/common';

/** 400 con el cuerpo de error legacy: `{ message: "Datos inválidos", errors }`. */
export function datosInvalidos(errors?: unknown): HttpException {
  return new HttpException(
    errors === undefined ? { message: 'Datos inválidos' } : { message: 'Datos inválidos', errors },
    HttpStatus.BAD_REQUEST,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reproduce el `.recover { case ex: Exception => InternalServerError(Json.obj("message" -> s"$prefix: ${ex.getMessage}")) }`
 * de los controladores Scala. Las HttpException ya construidas se propagan sin tocar.
 */
export async function legacyTry<T>(
  prefix: string,
  fn: () => Promise<T>,
  key: 'message' | 'mensaje' = 'message',
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new HttpException({ [key]: `${prefix}: ${errorMessage(error)}` }, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

/** Parsea un entero de query/path; null si no es entero. */
export function parseIntStrict(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return /^-?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

/** BigInt desde un id numérico de path/body. */
export function toBigInt(value: number | string | bigint): bigint {
  return BigInt(value);
}
