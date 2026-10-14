import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { EstadoNotificacionCorreo, MetodoPrestamo } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

/**
 * Payload del lector de correos: usa snake_case porque así lo envía el worker/webhook
 * (`external_message_id`, `fecha_correo`, `cuerpo_extraido`, `datos_parseados`).
 */
export class IngestaCorreoDto {
  @ApiProperty({ description: 'Message-ID de Gmail/IMAP. Garantiza idempotencia absoluta.' })
  @IsString()
  external_message_id: string;

  @ApiPropertyOptional({ example: 'alertas@bancolombia.com.co' })
  @IsOptional()
  @IsString()
  remitente?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  asunto?: string;

  @ApiProperty({ example: '2026-10-13T14:02:11Z' })
  @IsDateString()
  fecha_correo: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cuerpo_extraido?: string;

  @ApiPropertyOptional({
    example: { comercio: 'EXITO', monto: 50000, moneda: 'COP', ultimos_4: '1234', instrumento: 'CUENTA', tipo: 'EGRESO' },
    description: 'JSON estructurado por el parser. `ultimos_4` identifica la cuenta; `tipo` (INGRESO|EGRESO) opcional.',
  })
  @IsOptional()
  @IsObject()
  datos_parseados?: Record<string, unknown>;
}

export class ResponsableConciliacionDto {
  @ApiProperty({ description: 'Persona que asume parte de la compra' })
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: 50, description: 'Porcentaje (0-100) que asume' })
  @IsMoney({ maxDecimals: 4, positive: true })
  porcentajePago: number | string;

  @ApiPropertyOptional({ description: 'Cuotas que asume (default: todas las de la compra)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cantidadCuotas?: number;
}

export class ConvertirEnPrestamoDto {
  @ApiProperty({ description: 'Persona que debe el dinero (deudor)' })
  @IsInt()
  @IsPositive()
  responsableId: number;

  @ApiPropertyOptional({ example: '2026-11-15', description: 'Fecha estimada de cobro (default: la fecha del egreso)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'fechaCobro debe tener formato yyyy-MM-dd' })
  fechaCobro?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comentarios?: string;

  @ApiPropertyOptional({ enum: MetodoPrestamo })
  @IsOptional()
  @IsEnum(MetodoPrestamo)
  metodo?: MetodoPrestamo;
}

export class ConciliarCorreoDto {
  @ApiPropertyOptional({ enum: ['CONFIRMAR', 'DESCARTAR'], default: 'CONFIRMAR' })
  @IsOptional()
  @IsIn(['CONFIRMAR', 'DESCARTAR'])
  accion?: 'CONFIRMAR' | 'DESCARTAR';

  @ApiPropertyOptional({ description: 'Categoría a asignar a la transacción' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  categoriaId?: number;

  @ApiPropertyOptional({
    description: 'Cuenta a usar si la ingesta no pudo identificarla por los últimos 4 dígitos (genera la transacción)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaId?: number;

  @ApiPropertyOptional({ description: 'Corrige el concepto detectado (transacción o compra)' })
  @IsOptional()
  @IsString()
  concepto?: string;

  @ApiPropertyOptional({ description: 'Corrige el monto (COP) detectado' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  monto?: number | string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({ description: 'Compra de TC importada: nuevo número de cuotas (recalcula CuotasDetalle)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  numeroCuotas?: number;

  @ApiPropertyOptional({ description: 'Tarjeta a usar si la ingesta no la identificó (crea la compra a 1 cuota)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  tarjetaId?: number;

  @ApiPropertyOptional({ type: [ResponsableConciliacionDto], description: 'Responsables de la compra (Trigger 6 imputa el sub-ledger)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ResponsableConciliacionDto)
  responsables?: ResponsableConciliacionDto[];

  @ApiPropertyOptional({ type: ConvertirEnPrestamoDto, description: 'Convierte el egreso en un préstamo POR_COBRAR' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConvertirEnPrestamoDto)
  convertirEnPrestamo?: ConvertirEnPrestamoDto;
}

export class NotificacionesFiltroDto {
  @ApiPropertyOptional({ enum: EstadoNotificacionCorreo, description: 'Alias: estado_procesamiento' })
  @IsOptional()
  @IsEnum(EstadoNotificacionCorreo)
  estado?: EstadoNotificacionCorreo;

  @ApiPropertyOptional({ enum: EstadoNotificacionCorreo })
  @IsOptional()
  @IsEnum(EstadoNotificacionCorreo)
  estado_procesamiento?: EstadoNotificacionCorreo;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number;
}
