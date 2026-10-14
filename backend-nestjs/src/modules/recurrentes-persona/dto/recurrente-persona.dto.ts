import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ModalidadDuracion, NaturalezaRecurrentePersona } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `POST /api/recurrentes-persona` */
export class CrearRecurrentePersonaDto {
  @ApiProperty({ description: 'Persona a la que se le carga (o se le reconoce) el valor cada mes' })
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: 'Plan de celular' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  concepto: string;

  @ApiProperty({ example: '65000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  valorMensual: number | string;

  @ApiPropertyOptional({ enum: NaturalezaRecurrentePersona, default: NaturalezaRecurrentePersona.CARGO_A_COBRAR })
  @IsOptional()
  @IsEnum(NaturalezaRecurrentePersona)
  naturaleza?: NaturalezaRecurrentePersona;

  @ApiPropertyOptional({ enum: ModalidadDuracion, default: ModalidadDuracion.INDEFINIDO, description: 'INDEFINIDO = de por vida; PLAZO_FIJO = por `numeroMeses` meses' })
  @IsOptional()
  @IsEnum(ModalidadDuracion)
  modalidadDuracion?: ModalidadDuracion;

  @ApiPropertyOptional({ example: 6, description: 'Obligatorio con PLAZO_FIJO (1–600); no se admite con INDEFINIDO' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  numeroMeses?: number;

  @ApiPropertyOptional({ example: '2026-10', description: 'Primer mes en que se cobra; por defecto el mes actual' })
  @IsOptional()
  @Matches(PERIODO, { message: 'mesInicio debe tener formato YYYY-MM' })
  mesInicio?: string;

  @ApiPropertyOptional({ example: 1, default: 1, description: 'Día del mes de la fecha del movimiento (se ajusta al último día de meses cortos)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaCobro?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notas?: string;
}

/** `PATCH /api/recurrentes-persona/:id` (la persona no se puede cambiar: sus cuotas ya están en su estado de cuenta). */
export class ActualizarRecurrentePersonaDto extends PartialType(OmitType(CrearRecurrentePersonaDto, ['personaId'] as const)) {}

/** Filtros de `GET /api/recurrentes-persona`. */
export class FiltroRecurrentesPersonaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @IsPositive()
  personaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : undefined))
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ enum: ModalidadDuracion })
  @IsOptional()
  @IsEnum(ModalidadDuracion)
  modalidadDuracion?: ModalidadDuracion;
}
