import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TipoCuentaFinanciera } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';
import { EnteroOpcional, VacioAUndefined } from '../../../common/validators/normalizar-opcional.decorator';

export class NuevoProductoDto {
  @ApiPropertyOptional({ example: 'Bancolombia Ahorros', description: 'Cuenta nueva: nombre' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @ApiPropertyOptional({ enum: TipoCuentaFinanciera, description: 'Cuenta nueva: tipo (por defecto AHORROS)' })
  @VacioAUndefined()
  @IsOptional()
  @IsEnum(TipoCuentaFinanciera)
  tipoCuenta?: TipoCuentaFinanciera;

  @ApiPropertyOptional({ example: 'Bancolombia' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bancoEntidad?: string;

  @ApiPropertyOptional({ description: 'Saldo con el que se abre la cuenta (los movimientos reprocesados lo ajustan después)' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2, allowNegative: true })
  saldoInicial?: number | string;

  @ApiPropertyOptional({ description: 'Cuenta nueva: marcarla como la principal (recibe los avisos sin número, p. ej. la nómina)' })
  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;

  @ApiPropertyOptional({ example: 'American Express', description: 'Tarjeta nueva: franquicia' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  franquicia?: string;

  @ApiPropertyOptional({ example: 'Amex Platinum', description: 'Tarjeta nueva: descripción' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  descripcion?: string;
}

export class AsignarProductoDto {
  @ApiProperty({ example: '1927', description: 'Últimos 4 dígitos que reporta el banco' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'ultimos4 debe tener exactamente 4 dígitos' })
  ultimos4: string;

  @ApiProperty({ enum: ['TARJETA', 'CUENTA'] })
  @IsIn(['TARJETA', 'CUENTA'])
  destino: 'TARJETA' | 'CUENTA';

  @ApiPropertyOptional({ description: 'Producto existente al que se agregan los dígitos' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  id?: number;

  @ApiPropertyOptional({ type: NuevoProductoDto, description: 'Datos del producto a crear con estos dígitos (en lugar de `id`)' })
  @VacioAUndefined()
  @IsOptional()
  @ValidateNested()
  @Type(() => NuevoProductoDto)
  nuevo?: NuevoProductoDto;
}

export class AceptarSugerenciasDto {
  @ApiPropertyOptional({ type: [String], description: 'Solo estos últimos 4 (por defecto, todos los que tienen sugerencia)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^\d{4}$/, { each: true })
  ultimos4?: string[];
}

export class ReprocesarDto {
  @ApiPropertyOptional({
    example: '2026-06-02',
    description:
      'Fecha de corte (yyyy-MM-dd): los correos de esa fecha en adelante se registran como compras/transacciones nuevas; ' +
      'los anteriores solo se enlazan con lo que ya existe y, si no hay equivalente, quedan pendientes.',
  })
  @VacioAUndefined()
  @IsOptional()
  @IsDateString({ strict: true })
  desde?: string;

  @ApiPropertyOptional({ default: true, description: 'true = solo simula y devuelve el resumen, sin escribir nada' })
  @IsOptional()
  @IsBoolean()
  simular?: boolean;

  @ApiPropertyOptional({ type: [Number], description: 'Reprocesar solo estos correos' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsInt({ each: true })
  ids?: number[];

  @ApiPropertyOptional({ type: [String], description: 'Reprocesar solo los pendientes con alguno de estos motivos' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  motivos?: string[];

  @ApiPropertyOptional({ default: false, description: 'Si es true, incluye también correos en estado ERROR además de PENDIENTE' })
  @IsOptional()
  @IsBoolean()
  incluirConError?: boolean;

  @ApiPropertyOptional({ default: 50, description: 'Tamaño del sub-lote transaccional (entre 10 y 100)' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(100)
  chunkSize?: number;
}
