import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MetodoAporte, TipoObligacionMes } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class CreateObligacionMesDto {
  @ApiProperty({ enum: TipoObligacionMes })
  @IsEnum(TipoObligacionMes)
  tipoObligacion: TipoObligacionMes;

  @ApiProperty({ description: 'Persona responsable de cubrir la meta (p. ej. el papá)' })
  @IsInt()
  @IsPositive()
  responsablePrincipalId: number;

  @ApiProperty({ example: 'Septiembre 2026' })
  @IsString()
  @MaxLength(120)
  concepto: string;

  @ApiProperty({ example: '2026-09' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;

  @ApiProperty({ example: '1810000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  metaMensual: number | string;

  @ApiProperty({ example: '2026-09-01' })
  @Matches(FECHA, { message: 'fechaInicio debe tener formato yyyy-MM-dd' })
  fechaInicio: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @Matches(FECHA, { message: 'fechaFinal debe tener formato yyyy-MM-dd' })
  fechaFinal?: string;
}

export class AporteItemDto {
  @ApiProperty({ description: 'Quien entrega el dinero. Un tercero genera el cobro por cruce (Trigger 3)' })
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: '50000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  valor: number | string;

  @ApiProperty({ enum: MetodoAporte })
  @IsEnum(MetodoAporte)
  metodo: MetodoAporte;

  @ApiPropertyOptional({ example: 'Los debe pagar Andres' })
  @IsOptional()
  @IsString()
  comentarios?: string;
}

/** `POST /api/v2/obligaciones-mes/:id/aportes-dia` */
export class RegistrarAportesDiaDto {
  @ApiProperty({ example: '2026-09-14' })
  @Matches(FECHA, { message: 'fecha debe tener formato yyyy-MM-dd' })
  fecha: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiProperty({ type: [AporteItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AporteItemDto)
  items: AporteItemDto[];
}
