import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

export class CreateTransaccionDto {
  @ApiProperty({ enum: TipoTransaccion })
  @IsEnum(TipoTransaccion)
  tipoTransaccion: TipoTransaccion;

  @ApiPropertyOptional({ description: 'Obligatoria en EGRESO, PAGO_TARJETA, PAGO_PRESTAMO y TRANSFERENCIA' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaOrigenId?: number;

  @ApiPropertyOptional({ description: 'Obligatoria en INGRESO, REEMBOLSO_TERCERO y TRANSFERENCIA' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaDestinoId?: number;

  @ApiPropertyOptional({ description: 'Obligatoria en PAGO_TARJETA' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  tarjetaPagadaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  categoriaId?: number;

  @ApiPropertyOptional({ example: '2026-10-13T15:30:00-05:00', description: 'Por defecto: ahora' })
  @IsOptional()
  @IsDateString()
  fechaTransaccion?: string;

  @ApiProperty({ example: 'Mercado Éxito' })
  @IsString()
  @MaxLength(255)
  concepto: string;

  @ApiPropertyOptional({ example: 'COP' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  monedaOriginal?: string;

  @ApiProperty({ example: '150000.50', description: 'Monto en la divisa original (> 0, máx. 2 decimales; número o texto)' })
  @IsMoney({ maxDecimals: 2, positive: true })
  montoOriginal: number | string;

  @ApiPropertyOptional({ example: '4150.1234', description: 'TRM / tasa de conversión a COP. Obligatoria si la divisa no es COP' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4, positive: true })
  tasaCambio?: number | string;

  @ApiPropertyOptional({ description: 'Se calcula como montoOriginal × tasaCambio si se omite' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  montoCop?: number | string;

  @ApiPropertyOptional({ enum: OrigenRegistro })
  @IsOptional()
  @IsEnum(OrigenRegistro)
  origenRegistro?: OrigenRegistro;

  @ApiPropertyOptional({ enum: EstadoTransaccion, description: "Default: CONFIRMADO (manual) / PENDIENTE_REVISION (email)" })
  @IsOptional()
  @IsEnum(EstadoTransaccion)
  estado?: EstadoTransaccion;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({ description: 'Iteración 2 — Fase 4: marca como transferencia entre cuentas propias' })
  @IsOptional()
  @IsBoolean()
  esTransferenciaInterna?: boolean;

  @ApiPropertyOptional({ description: 'Iteración 2 — Fase 4: cuenta contraparte de la transferencia interna' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaContraparteId?: number;

  @ApiPropertyOptional({ type: [String], example: ['#rappi', '#domicilios'] })
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

/** Iteración 2 — Fase 4: DTO para crear un par espejo de transferencia entre cuentas propias. */
export class CrearTransferenciaInternaDto {
  @ApiProperty({ description: 'Cuenta de donde sale el dinero' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  cuentaOrigenId: number;

  @ApiProperty({ description: 'Cuenta propia donde entra el dinero' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  cuentaDestinoId: number;

  @ApiProperty({ example: '500000.00', description: 'Monto transferido (> 0, máx. 2 decimales)' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiPropertyOptional({ example: 'COP' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  monedaOriginal?: string;

  @ApiPropertyOptional({ example: '4150.0000' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4, positive: true })
  tasaCambio?: number | string;

  @ApiPropertyOptional({ example: '2026-10-15T12:00:00-05:00' })
  @IsOptional()
  @IsDateString()
  fechaTransaccion?: string;

  @ApiPropertyOptional({ example: 'Traslado a cuenta de ahorros secundaria' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({ description: 'Costo opcional de comisión bancaria o GMF (4x1000) registrado como gasto real separado' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  comisionGMF?: number | string;

  @ApiPropertyOptional({ description: 'Categoría opcional para el gasto del 4x1000 / comisión' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoriaComisionId?: number;

  @ApiPropertyOptional({ type: [String], example: ['#transferencias'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

/** `PATCH /api/v2/transacciones/:id` — el Trigger 2 revierte el impacto anterior y aplica el nuevo. */
export class UpdateTransaccionDto {
  @ApiPropertyOptional({ enum: TipoTransaccion })
  @IsOptional()
  @IsEnum(TipoTransaccion)
  tipoTransaccion?: TipoTransaccion;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  cuentaOrigenId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  cuentaDestinoId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  tarjetaPagadaId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  categoriaId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fechaTransaccion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  montoOriginal?: number | string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMoney({ maxDecimals: 4, positive: true })
  tasaCambio?: number | string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  montoCop?: number | string;

  @ApiPropertyOptional({ enum: EstadoTransaccion })
  @IsOptional()
  @IsEnum(EstadoTransaccion)
  estado?: EstadoTransaccion;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({ type: [String], example: ['#rappi', '#domicilios'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ nullable: true, example: 'Rappi' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  comercioCanonico?: string | null;
}

export class TransaccionesFiltroDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'Mes completo (YYYY-MM). Tiene prioridad sobre desde/hasta.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiPropertyOptional({ enum: TipoTransaccion, description: 'Alias de `tipo`' })
  @IsOptional()
  @IsEnum(TipoTransaccion)
  tipo_transaccion?: TipoTransaccion;

  @ApiPropertyOptional({ description: 'Alias de `cuentaId`' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cuenta_id?: number;

  @ApiPropertyOptional({ description: 'Alias de `categoriaId`' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoria_id?: number;

  @ApiPropertyOptional({ enum: OrigenRegistro })
  @IsOptional()
  @IsEnum(OrigenRegistro)
  origen_registro?: OrigenRegistro;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({ description: 'Cuenta de origen o de destino' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cuentaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoriaId?: number;

  @ApiPropertyOptional({ enum: TipoTransaccion })
  @IsOptional()
  @IsEnum(TipoTransaccion)
  tipo?: TipoTransaccion;

  @ApiPropertyOptional({ enum: EstadoTransaccion })
  @IsOptional()
  @IsEnum(EstadoTransaccion)
  estado?: EstadoTransaccion;

  @ApiPropertyOptional({ description: 'Filtrar por es_transferencia_interna (true/false)' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : undefined))
  @IsBoolean()
  esTransferenciaInterna?: boolean;

  @ApiPropertyOptional({ description: 'Filtrar por tag (ej. #rappi o rappi)' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset?: number;
}
