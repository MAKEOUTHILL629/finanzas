import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { TipoCategoria, TipoCuentaFinanciera } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

export class CreateCuentaFinancieraDto {
  @ApiProperty({ example: 'Bancolombia Ahorros' })
  @IsString()
  @MaxLength(120)
  nombre: string;

  @ApiProperty({ enum: TipoCuentaFinanciera })
  @IsEnum(TipoCuentaFinanciera)
  tipoCuenta: TipoCuentaFinanciera;

  @ApiPropertyOptional({ example: 'Bancolombia' })
  @IsOptional()
  @IsString()
  bancoEntidad?: string;

  @ApiPropertyOptional({ example: '1234', description: 'Usado por el parser de correos para identificar la cuenta' })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'ultimos4Digitos debe tener 4 dígitos' })
  ultimos4Digitos?: string;

  @ApiPropertyOptional({ example: 'COP', description: "Por defecto 'COP'" })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  moneda?: string;

  @ApiPropertyOptional({
    example: 1500000,
    description: 'Saldo con el que se abre la cuenta. Después solo lo modifica el Trigger 2 de la BD.',
  })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, allowNegative: true })
  saldoInicial?: number | string;
}

/** `saldo_actual` NO es editable: lo mantiene exclusivamente `trg_actualizar_saldo_cuenta`. */
export class UpdateCuentaFinancieraDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @ApiPropertyOptional({ enum: TipoCuentaFinanciera })
  @IsOptional()
  @IsEnum(TipoCuentaFinanciera)
  tipoCuenta?: TipoCuentaFinanciera;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bancoEntidad?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'ultimos4Digitos debe tener 4 dígitos' })
  ultimos4Digitos?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCategoriaDto {
  @ApiProperty({ example: 'Mercado' })
  @IsString()
  @MaxLength(80)
  nombre: string;

  @ApiProperty({ enum: TipoCategoria })
  @IsEnum(TipoCategoria)
  tipo: TipoCategoria;

  @ApiPropertyOptional({ example: 'shopping-cart' })
  @IsOptional()
  @IsString()
  icono?: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color debe ser hexadecimal (#RRGGBB)' })
  color?: string;
}

export class UpdateCategoriaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  nombre?: string;

  @ApiPropertyOptional({ enum: TipoCategoria })
  @IsOptional()
  @IsEnum(TipoCategoria)
  tipo?: TipoCategoria;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color debe ser hexadecimal (#RRGGBB)' })
  color?: string;
}
