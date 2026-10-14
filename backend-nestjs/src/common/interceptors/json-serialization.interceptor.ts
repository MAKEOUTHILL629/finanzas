import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Regla 2 — Serialización transparente hacia Angular:
 *  - `bigint` (int8)                      → `number` (si cabe en Number.MAX_SAFE_INTEGER; si no, string para no perder precisión)
 *  - `Prisma.Decimal` / `Decimal` (numeric) → `number` (compatibilidad con componentes y gráficas existentes)
 *  - `Date`                                → ISO-8601 (los endpoints legacy ya entregan su formato propio como number/string)
 *
 * `JSON.stringify` lanzaría `TypeError: Do not know how to serialize a BigInt` y serializaría Decimal como string.
 */
export function serializeForJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'bigint':
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    case 'object':
      break;
    default:
      return value;
  }

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Prisma.Decimal || Decimal.isDecimal(value)) return (value as Decimal).toNumber();
  if (Array.isArray(value)) return value.map(serializeForJson);
  if (Buffer.isBuffer(value) || value instanceof StreamableFile) return value;

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value; // streams, clases ajenas, etc.

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = serializeForJson(val);
  }
  return out;
}

@Injectable()
export class JsonSerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data: unknown) => serializeForJson(data)));
  }
}
