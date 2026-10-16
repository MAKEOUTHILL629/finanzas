import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MOTIVOS_REEMPLAZO, MotivoReemplazo } from '../plasticos.util';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MSG_FECHA = 'La fecha debe tener formato yyyy-MM-dd';

/** `POST /api/tarjetas/:id/plasticos/reemplazar` — registra el plástico nuevo y archiva el anterior. */
export class ReemplazarPlasticoDto {
  @ApiProperty({ example: '9587', description: 'Últimos 4 dígitos del plástico nuevo' })
  @Matches(/^\d{4}$/, { message: 'ultimos4 debe tener exactamente 4 dígitos' })
  ultimos4: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Desde cuándo rige el plástico nuevo (por defecto, hoy)' })
  @IsOptional()
  @Matches(FECHA, { message: MSG_FECHA })
  vigenteDesde?: string;

  @ApiPropertyOptional({ enum: MOTIVOS_REEMPLAZO, description: 'Por qué se cambió el plástico anterior' })
  @IsOptional()
  @IsIn([...MOTIVOS_REEMPLAZO])
  motivo?: MotivoReemplazo;

  @ApiPropertyOptional({ example: 'Reposición por pérdida' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}

/** `PATCH /api/tarjetas/:id/plasticos/:plasticoId` — corrige fechas o notas; `esActivo: true` lo vuelve el plástico activo. */
export class ActualizarPlasticoDto {
  @ApiPropertyOptional({ example: '2025-01-10', nullable: true, description: 'null = desconocido' })
  @IsOptional()
  @Matches(FECHA, { message: MSG_FECHA })
  vigenteDesde?: string | null;

  @ApiPropertyOptional({ example: '2026-09-30', nullable: true, description: 'null = sin cierre' })
  @IsOptional()
  @Matches(FECHA, { message: MSG_FECHA })
  vigenteHasta?: string | null;

  @ApiPropertyOptional({ enum: MOTIVOS_REEMPLAZO, nullable: true })
  @IsOptional()
  @IsIn([...MOTIVOS_REEMPLAZO])
  motivo?: MotivoReemplazo | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string | null;

  @ApiPropertyOptional({ example: true, description: 'Solo se admite true: el plástico pasa a ser el activo y el actual se archiva' })
  @IsOptional()
  @IsBoolean()
  esActivo?: boolean;
}
