import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { TipoCategoria, TipoCuentaFinanciera } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

/**
 * Últimos 4 dígitos del producto. Una cuenta puede llevar varios (cuenta + tarjeta débito): `3698,4278` o `3698 4278`.
 * El parser de correos busca el número del correo entre ellos.
 */
export const ULTIMOS_4 = /^\d{4}(?:\s*[,;\s]\s*\d{4})*$/;

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
  @MaxLength(60)
  @Matches(ULTIMOS_4, { message: 'ultimos4Digitos debe tener 4 dígitos (o varios grupos de 4 separados por coma, p. ej. "3698,4278")' })
  ultimos4Digitos?: string;

  @ApiPropertyOptional({ example: 'COP', description: "Por defecto 'COP'" })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  moneda?: string;

  @ApiPropertyOptional({ example: false, description: 'Cuenta que recibe los avisos del banco que no traen número (p. ej. la nómina)' })
  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;

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
  @MaxLength(60)
  @Matches(ULTIMOS_4, { message: 'ultimos4Digitos debe tener 4 dígitos (o varios grupos de 4 separados por coma, p. ej. "3698,4278")' })
  ultimos4Digitos?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Marca la cuenta principal; al marcarla se desmarca la anterior' })
  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;
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
