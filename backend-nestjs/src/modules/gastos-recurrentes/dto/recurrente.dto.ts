import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { EstadoPeriodoRecurrente, FrecuenciaRecurrente } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

export class ResponsableRecurrenteDto {
  @ApiPropertyOptional({ description: 'Persona responsable. null = tu propia cuota parte' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  personaId?: number;

  @ApiPropertyOptional({ example: 25, description: 'Porcentaje (0-100)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  porcentajeParticipacion?: number | string;

  @ApiPropertyOptional({ example: 50000, description: 'Valor fijo si el acuerdo no es porcentual' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2 })
  montoFijoParticipacion?: number | string;
}

export class CreatePlantillaRecurrenteDto {
  @ApiProperty({ example: 'Mercado Casa' })
  @IsString()
  @MaxLength(120)
  nombre: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  categoriaId?: number;

  @ApiPropertyOptional({ enum: FrecuenciaRecurrente })
  @IsOptional()
  @IsEnum(FrecuenciaRecurrente)
  frecuencia?: FrecuenciaRecurrente;

  @ApiPropertyOptional({ example: 15, minimum: 1, maximum: 31 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaVencimientoEstimado?: number;

  @ApiPropertyOptional({ description: 'true si cambia cada mes (energía, mercado)' })
  @IsOptional()
  @IsBoolean()
  esMontoVariable?: boolean;

  @ApiPropertyOptional({ example: 'COP' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  moneda?: string;

  @ApiProperty({ example: 800000 })
  @IsMoney({ maxDecimals: 2 })
  montoBaseEstimado: number | string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaDebitoDefaultId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  tarjetaCreditoDefaultId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  prestamoAsociadoId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [ResponsableRecurrenteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ResponsableRecurrenteDto)
  responsables?: ResponsableRecurrenteDto[];
}

/** En `PATCH`, enviar `responsables` REEMPLAZA el reparto completo. */
export class UpdatePlantillaRecurrenteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  categoriaId?: number | null;

  @ApiPropertyOptional({ enum: FrecuenciaRecurrente })
  @IsOptional()
  @IsEnum(FrecuenciaRecurrente)
  frecuencia?: FrecuenciaRecurrente;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaVencimientoEstimado?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  esMontoVariable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMoney({ maxDecimals: 2 })
  montoBaseEstimado?: number | string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  cuentaDebitoDefaultId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  tarjetaCreditoDefaultId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  prestamoAsociadoId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [ResponsableRecurrenteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ResponsableRecurrenteDto)
  responsables?: ResponsableRecurrenteDto[];
}

/** `PATCH /api/v2/periodos-recurrentes/:id/registrar-pago` */
export class RegistrarPagoPeriodoDto {
  @ApiProperty({ example: '845300.50', description: 'Monto real pagado' })
  @IsMoney({ maxDecimals: 2, positive: true })
  montoRealPagado: number | string;

  @ApiPropertyOptional({
    enum: [EstadoPeriodoRecurrente.PAGADO, EstadoPeriodoRecurrente.FACTURADO],
    description: "Por defecto 'PAGADO'. Ambos disparan el Trigger 7 (cargo a cada participante).",
  })
  @IsOptional()
  @IsEnum(EstadoPeriodoRecurrente)
  estado?: EstadoPeriodoRecurrente;

  @ApiPropertyOptional({ description: 'Crea la transacción EGRESO desde esta cuenta (default: cuenta de débito de la plantilla)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaOrigenId?: number;

  @ApiPropertyOptional({ description: 'true = registra el EGRESO en Transacciones y lo enlaza' })
  @IsOptional()
  @IsBoolean()
  crearTransaccion?: boolean;

  @ApiPropertyOptional({ description: 'Enlaza una transacción ya existente' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  transaccionPagoId?: number;

  @ApiPropertyOptional({ description: 'Enlaza la compra con tarjeta con la que se pagó' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  compraCreditoPagoId?: number;
}

/** Fase 4 (Iteración 3): convertir compras/transacciones existentes en un pago recurrente. */
export class DesdeMovimientoDto {
  @ApiProperty({ enum: ['COMPRA_CREDITO', 'TRANSACCION'], example: 'COMPRA_CREDITO' })
  @IsString()
  origenTipo: 'COMPRA_CREDITO' | 'TRANSACCION';

  @ApiProperty({ type: [Number], example: [101, 102], description: 'Movimientos origen (individual o lote); el primero siembra la plantilla' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  origenIds: number[];

  @ApiPropertyOptional({ enum: FrecuenciaRecurrente, example: FrecuenciaRecurrente.MENSUAL })
  @IsOptional()
  @IsEnum(FrecuenciaRecurrente)
  frecuencia?: FrecuenciaRecurrente;

  @ApiPropertyOptional({ example: 7, minimum: 1, maximum: 31, description: 'Día de cobro estimado; por defecto, el día del movimiento origen' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaCobroEstimado?: number;

  @ApiPropertyOptional({ description: 'true si el monto cambia cada mes' })
  @IsOptional()
  @IsBoolean()
  esMontoVariable?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Vincula también los pagos históricos del mismo comercio/destinatario' })
  @IsOptional()
  @IsBoolean()
  vincularHistoricoSimilar?: boolean;
}

export class ProyectarPeriodoDto {
  @ApiProperty({ example: '2026-11' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;
}
