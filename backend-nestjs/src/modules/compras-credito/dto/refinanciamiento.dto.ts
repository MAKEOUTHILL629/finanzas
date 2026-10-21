import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';
import { EnteroOpcional, VacioAUndefined } from '../../../common/validators/normalizar-opcional.decorator';

/** Lo que el asesor del banco da por teléfono para simular una unificación de deuda. */
export class SimularRefinanciamientoDto {
  @ApiProperty({ example: 2, description: 'Tarjeta de crédito cuyas compras se unifican' })
  @IsInt()
  @IsPositive()
  tarjetaId: number;

  @ApiProperty({ type: [Number], example: [312, 311, 310], description: 'Compras pendientes de esa tarjeta que se unifican' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  compraIds: number[];

  @ApiProperty({ example: 24, minimum: 1, maximum: 120, description: 'Número de cuotas nuevas' })
  @IsInt()
  @Min(1)
  @Max(120)
  numeroCuotas: number;

  @ApiPropertyOptional({ example: '1.87', description: 'Tasa MENSUAL (M.V.) en %. Una sola: esta o la efectiva anual.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaMensual?: number | string;

  @ApiPropertyOptional({ example: '24.9', description: 'Tasa EFECTIVA ANUAL (E.A.) en %: se convierte a mensual.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaEfectivaAnual?: number | string;

  @ApiPropertyOptional({ example: '655000', description: 'Cuota mensual exacta que dio el banco (con seguros o ajustes); si falta se calcula.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  cuotaMensual?: number | string;

  @ApiPropertyOptional({ example: '2026-10-17', description: 'Día en que el banco aplica la unificación (por defecto, hoy en Colombia)' })
  @VacioAUndefined()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fecha debe tener el formato yyyy-MM-dd' })
  fecha?: string;
}

export class EjecutarRefinanciamientoDto extends SimularRefinanciamientoDto {
  @ApiPropertyOptional({ example: 'Refinanciamiento Amex ··1927 17/10/2026' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional({ description: 'Notas de la llamada (asesor, condiciones…)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descripcion?: string;
}

/** Barrido automático por fecha de corte: el banco unificó todo lo vigente hasta `fechaCorte` por $X. */
export class SimularBarridoFechaDto {
  @ApiProperty({ type: [Number], example: [2], description: 'Tarjeta(s) de crédito barridas por el banco' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  tarjetaIds: number[];

  @ApiProperty({ example: '2026-09-07', description: 'Fecha exacta del refinanciamiento / corte del barrido' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fechaCorte debe tener el formato yyyy-MM-dd' })
  fechaCorte: string;

  @ApiProperty({ example: '12500000', description: 'Valor total unificado por el banco ($X)' })
  @IsMoney({ maxDecimals: 2, positive: true })
  montoUnificadoBanco: number | string;

  @ApiProperty({ example: 24, minimum: 1, maximum: 120, description: 'Número de cuotas nuevas' })
  @IsInt()
  @Min(1)
  @Max(120)
  numeroCuotas: number;

  @ApiPropertyOptional({ example: '1.87', description: 'Tasa MENSUAL (M.V.) en %. Una sola: esta o la efectiva anual.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaMensual?: number | string;

  @ApiPropertyOptional({ example: '24.9', description: 'Tasa EFECTIVA ANUAL (E.A.) en %: se convierte a mensual.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaEfectivaAnual?: number | string;

  @ApiPropertyOptional({ example: '655000', description: 'Cuota mensual exacta que dio el banco; si falta se calcula.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  cuotaMensual?: number | string;
}

export class EjecutarBarridoFechaDto extends SimularBarridoFechaDto {
  @ApiPropertyOptional({ example: 'Unificación / Refinanciamiento Tarjeta (Corte 07/Sep)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional({ description: 'Notas de la llamada (asesor, condiciones…)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descripcion?: string;
}

export class CandidatasQueryDto {
  @ApiProperty({ example: 2 })
  @EnteroOpcional()
  @IsInt()
  @IsPositive()
  tarjetaId: number;
}
