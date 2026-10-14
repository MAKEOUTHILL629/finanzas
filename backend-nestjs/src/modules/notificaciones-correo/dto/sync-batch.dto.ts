import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  validateSync,
  ValidateNested,
} from 'class-validator';
import { datosInvalidos } from '../../../common/utils/legacy-http.util';

export const MAX_ITEMS_POR_LOTE = 500;

/**
 * Un correo de Bancolombia ya clasificado por el Google Apps Script.
 * Valores esperados — `tipo`: Compra | Transferencia | Pago | Ingreso | Pago Proveedor | Abono Tarjeta | Avance | Retiro |
 * Abono Deuda | Desconocido. `metodo`: Tarjeta Credito | Cuenta Ahorros/Corriente | Cuenta Ahorros | QR |
 * Transfiya/Bre-b | Boton Bancolombia | Tarjeta Debito | Pago Tarjeta | Llaves. Otros valores no fallan: quedan PENDIENTE.
 */
export class NotificacionItemDto {
  @ApiProperty({ description: 'Message-ID de Gmail. Clave de idempotencia estricta.', example: '<CAF123@mail.gmail.com>' })
  @IsString()
  @IsNotEmpty()
  externalMessageId: string;

  @ApiProperty({ example: '2026-10-13', description: 'YYYY-MM-DD (hora local del buzón)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fecha debe tener formato YYYY-MM-DD' })
  fecha: string;

  @ApiProperty({ example: '14:02:11', description: 'HH:mm:ss' })
  @IsString()
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/, { message: 'hora debe tener formato HH:mm:ss' })
  hora: string;

  @ApiProperty({ example: 'Compra' })
  @IsString()
  tipo: string;

  @ApiProperty({ example: 'Tarjeta Credito' })
  @IsString()
  metodo: string;

  @ApiPropertyOptional({ example: 'EXITO COLOMBIA' })
  @IsOptional()
  @IsString()
  comercio?: string;

  @ApiPropertyOptional({ example: 'T.Cred *1927', description: 'Producto de origen tal cual lo reporta el banco' })
  @IsOptional()
  @IsString()
  origenRaw?: string;

  @ApiPropertyOptional({ example: '50.000', description: 'Valor tal cual lo reporta el banco (texto o número)' })
  @IsOptional()
  @IsDefined()
  valor?: string | number;

  @ApiPropertyOptional({ enum: ['COP', 'USD'], default: 'COP' })
  @IsOptional()
  @IsIn(['COP', 'USD'])
  moneda?: 'COP' | 'USD';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  linkCorreo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  asunto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cuerpoExtraido?: string;

  @ApiPropertyOptional({ description: 'true si el script no pudo interpretar el correo' })
  @IsOptional()
  @IsBoolean()
  esErrorParsing?: boolean;
}

export class SyncNotificacionesBatchDto {
  @ApiProperty({ type: [NotificacionItemDto], maxItems: MAX_ITEMS_POR_LOTE })
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS_POR_LOTE)
  @ValidateNested({ each: true })
  @Type(() => NotificacionItemDto)
  items: NotificacionItemDto[];
}

/**
 * Acepta `{ items: [...] }` (documentado), `{ notificaciones: [...] }` o directamente `[...]`, para no depender
 * de cómo serialice el lote el Apps Script. Devuelve instancias validadas o lanza 400 con el detalle por ítem.
 */
export function parseSyncBatchBody(body: unknown): NotificacionItemDto[] {
  let crudo: unknown = body;
  if (!Array.isArray(body) && typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    crudo = b.items ?? b.notificaciones;
  }
  if (!Array.isArray(crudo)) {
    throw datosInvalidos({ items: ['Se esperaba un arreglo `items` con las notificaciones'] });
  }
  if (crudo.length > MAX_ITEMS_POR_LOTE) {
    throw datosInvalidos({ items: [`El lote supera el máximo de ${MAX_ITEMS_POR_LOTE} notificaciones`] });
  }

  const errores: Record<string, string[]> = {};
  const items: NotificacionItemDto[] = [];
  crudo.forEach((raw, indice) => {
    const item = plainToInstance(NotificacionItemDto, raw);
    const problemas = validateSync(item, { whitelist: true });
    if (problemas.length > 0) {
      const id = (raw as { externalMessageId?: string } | null)?.externalMessageId ?? `#${indice}`;
      errores[`items[${indice}] (${id})`] = problemas.flatMap((p) => Object.values(p.constraints ?? {}));
    } else {
      items.push(item);
    }
  });
  if (Object.keys(errores).length > 0) throw datosInvalidos(errores);
  return items;
}
