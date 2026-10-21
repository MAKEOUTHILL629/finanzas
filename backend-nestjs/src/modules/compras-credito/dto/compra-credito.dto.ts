import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsPositive, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';
import { EnteroOpcional, VacioAUndefined } from '../../../common/validators/normalizar-opcional.decorator';

/**
 * Entrada de dominio para crear/actualizar una compra (la usan el controlador JSON y el cargador CSV).
 * Los montos se aceptan como `number | string` solo como LITERAL de entrada; se convierten a Decimal de inmediato.
 */
export interface CompraCreditoInput {
  concepto: string;
  valorCompra?: number | string | null;
  fechaCompra: string | Date;
  numeroCuotas: number;
  interes: number | string;
  descripcion: string;
  estado: string;
  tarjeta: number | bigint;
  monedaOriginal?: string | null;
  valorMonedaOriginal?: number | string | null;
  tasaCambioAplicada?: number | string | null;
  trmConfirmada?: boolean | null;
  /** Plástico con el que se pagó (debe ser de esa tarjeta). Sin él se usa el vigente en la fecha de la compra. */
  plasticoId?: number | bigint | null;
  /** Últimos 4 dígitos del aviso del banco: identifica el plástico sin que el llamador conozca su id (correos). */
  plasticoUltimos4?: string | null;
  /** Tags transversales con '#' (ej. ['#rappi', '#domicilios']). */
  tags?: string[];
  /** Comercio canónico normalizado (ej. 'Rappi', 'DiDi Food', 'DiDi Rides'). */
  comercioCanonico?: string | null;
}

/** `POST /api/compras-credito` — campos del contrato legacy (+ campos multimoneda y tags opcionales). */
export class CreateCompraCreditoDto implements CompraCreditoInput {
  @ApiProperty({ example: 'Nevera Samsung' })
  @IsString()
  concepto: string;

  @ApiPropertyOptional({ example: 2500000, description: 'Valor en COP. Obligatorio si la moneda es COP.' })
  @IsOptional()
  @IsNumber()
  valorCompra?: number;

  @ApiProperty({ example: '2024-04-05', description: 'Formato yyyy-MM-dd (se ignora cualquier sufijo, como el legacy)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'fechaCompra debe tener formato yyyy-MM-dd' })
  fechaCompra: string;

  @ApiProperty({ example: 36 })
  @IsInt()
  @Min(1)
  numeroCuotas: number;

  @ApiProperty({ example: 1.8895, description: 'Interés mensual en %' })
  @IsNumber()
  interes: number;

  @ApiProperty({ example: 'Compra en tienda Éxito' })
  @IsString()
  descripcion: string;

  @ApiProperty({ example: 'Pendiente' })
  @IsString()
  estado: string;

  @ApiProperty({ example: 1, description: 'ID de la tarjeta' })
  @IsInt()
  tarjeta: number;

  @ApiPropertyOptional({ example: 'USD', description: "Por defecto 'COP'" })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  monedaOriginal?: string;

  @ApiPropertyOptional({ example: 49.99, description: 'Monto en la divisa original (obligatorio si no es COP)' })
  @IsOptional()
  @IsNumber()
  valorMonedaOriginal?: number;

  @ApiPropertyOptional({ example: 4200, description: 'TRM aplicada (obligatoria si no es COP)' })
  @IsOptional()
  @IsNumber()
  tasaCambioAplicada?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  trmConfirmada?: boolean;

  @ApiPropertyOptional({ example: 3, description: 'Plástico con el que se pagó (de esa tarjeta). Si se omite: el vigente en la fecha de la compra.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  plasticoId?: number;

  @ApiPropertyOptional({ type: [String], example: ['#domicilios', '#rappi'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ example: 'Rappi' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  comercioCanonico?: string;
}

/** `PUT /api/compras-credito` y `POST /api/recalcular-compra-credito`. */
export class UpdateCompraCreditoDto extends CreateCompraCreditoDto {
  @ApiProperty({ example: 5 })
  @IsInt()
  id: number;
}

/** `PUT /api/compras-credito/:id` — el id viaja en la ruta. */
export class ActualizarCompraCreditoDto extends OmitType(UpdateCompraCreditoDto, ['id'] as const) {}

/** `PATCH /api/compras-credito/:id/confirmar-trm` */
export class ConfirmarTrmDto {
  @ApiProperty({ example: '4150.00', description: 'TRM real de facturación (número o texto, hasta 4 decimales)' })
  @IsMoney({ maxDecimals: 4, positive: true })
  nuevaTrm: number | string;

  @ApiPropertyOptional({ example: true, description: 'true (default) = TRM definitiva' })
  @IsOptional()
  @IsBoolean()
  confirmarDefinitivo?: boolean;
}

/**
 * `PATCH /api/compras-credito/:id` — edición en línea del detalle: solo se envía lo que cambió. Texto, estado, plástico, tags y comercio
 * son una actualización simple; valor, cuotas, interés, fecha o tarjeta recalculan las cuotas.
 */
export class PatchCompraCreditoDto {
  @ApiPropertyOptional({ example: 'Nevera Samsung' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descripcion?: string;

  @ApiPropertyOptional({ example: 'Pendiente' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  estado?: string;

  @ApiPropertyOptional({ description: 'Plástico con el que se pagó (debe ser de la tarjeta de la compra)' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  plasticoId?: number;

  @ApiPropertyOptional({ example: '2500000' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  valorCompra?: number | string;

  @ApiPropertyOptional({ example: '2026-10-15' })
  @VacioAUndefined()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'fechaCompra debe tener formato yyyy-MM-dd' })
  fechaCompra?: string;

  @ApiPropertyOptional({ example: 12 })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  numeroCuotas?: number;

  @ApiPropertyOptional({ example: '1.8895', description: 'Interés mensual en %' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  interes?: number | string;

  @ApiPropertyOptional({ description: 'ID de la tarjeta de crédito' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  tarjeta?: number;

  @ApiPropertyOptional({ type: [String], example: ['#domicilios', '#rappi'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ example: 'Rappi' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  comercioCanonico?: string | null;
}

/**
 * `PATCH /api/v2/compras-credito/propagar-edicion-similares` — Fase 2 (Iteración 3):
 * Propaga selectivamente cuotas, responsables porcentuales, tags y comercio canónico desde una compra origen
 * hacia las compras similares marcadas por el usuario.
 */
export class PropagarEdicionSimilaresDto {
  @ApiProperty({ example: 5 })
  @IsInt()
  @IsPositive()
  compraOrigenId: number;

  @ApiProperty({ type: [Number], example: [12, 18, 24] })
  @IsArray()
  @IsInt({ each: true })
  compraDestinoIds: number[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  aplicarCuotas?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  aplicarResponsables?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  aplicarTags?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  aplicarComercioCanonico?: boolean;

  @ApiPropertyOptional({ enum: ['MERGE', 'REEMPLAZAR'], default: 'MERGE' })
  @IsOptional()
  @IsString()
  modoTags?: 'MERGE' | 'REEMPLAZAR';
}
