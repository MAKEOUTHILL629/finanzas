import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { rate, toDecimal } from '../../common/utils/decimal.util';

export interface NuevaNotificacion {
  ownerUserId: bigint;
  externalMessageId: string;
  remitente?: string | null;
  asunto?: string | null;
  fechaCorreo: Date;
  cuerpoExtraido?: string | null;
  datosParseados?: Record<string, unknown> | null;
}

/**
 * `INSERT ... ON CONFLICT (external_message_id) DO NOTHING RETURNING id` (sección 6.2.B del documento de BD).
 * Devuelve el id nuevo, o `null` si el correo ya existía (idempotencia absoluta, también bajo concurrencia).
 */
export async function insertarNotificacionIdempotente(
  tx: Prisma.TransactionClient,
  n: NuevaNotificacion,
): Promise<bigint | null> {
  const datosJson = n.datosParseados ? JSON.stringify(n.datosParseados) : null;
  const filas = await tx.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO "NotificacionesCorreo"
      (owner_user_id, external_message_id, remitente, asunto, fecha_correo, cuerpo_extraido, datos_parseados, estado_procesamiento)
    VALUES
      (${n.ownerUserId}::int8, ${n.externalMessageId}, ${n.remitente ?? null}, ${n.asunto ?? null},
       ${n.fechaCorreo}::timestamptz, ${n.cuerpoExtraido ?? null}, ${datosJson}::jsonb, 'PENDIENTE')
    ON CONFLICT (external_message_id) DO NOTHING
    RETURNING id`;
  return filas.length > 0 ? filas[0].id : null;
}

/**
 * TRM provisional para movimientos en USD que llegan por correo sin tasa: la de la última compra en USD del usuario
 * o, si no hay, la TRM de respaldo configurada (`DEFAULT_TRM_USD`). `null` si no hay ninguna.
 */
export async function resolverTrmUsd(
  tx: Prisma.TransactionClient,
  ownerUserId: bigint,
  respaldo: Decimal | null,
): Promise<Decimal | null> {
  const ultima = await tx.comprasCredito.findFirst({
    where: { owner_user_id: ownerUserId, moneda_original: 'USD', tasa_cambio_aplicada: { not: null } },
    orderBy: { id: 'desc' },
    select: { tasa_cambio_aplicada: true },
  });
  if (ultima?.tasa_cambio_aplicada) return rate(toDecimal(ultima.tasa_cambio_aplicada));
  return respaldo;
}
