import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';

/**
 * `PUT /api/tarjetas/:id`. Todos los campos son opcionales: solo se modifica lo que llega.
 * Ojo: el trigger `trg_set_periodo_cuota` usa `diaCorte` al INSERTAR/ACTUALIZAR una cuota; cambiarlo no recalcula
 * `periodo_facturacion` de las cuotas ya guardadas (para eso hay que volver a calcular las cuotas de la compra).
 */
export class ActualizarTarjetaDto {
  @ApiPropertyOptional({ example: 'Visa' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  franquicia?: string;

  @ApiPropertyOptional({ example: 'Oro *1927', description: 'Los últimos 4 dígitos aquí permiten identificar la tarjeta en los correos del banco' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  descripcion?: string;

  @ApiPropertyOptional({ example: 15, description: 'Día del mes en que corta el extracto (1-31)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaCorte?: number;

  @ApiPropertyOptional({ example: 5, description: 'Día del mes límite para pagar (1-31)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaLimitePago?: number;

  @ApiPropertyOptional({ example: '12000000.00', description: 'Cupo total (máx. 2 decimales)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  cupoTotal?: number | string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  permiteDolares?: boolean;

  @ApiPropertyOptional({ example: '1.8895', description: 'Tasa mensual de compras en % (máx. 4 decimales)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaInteresCompra?: number | string;

  @ApiPropertyOptional({ example: '2.1', description: 'Tasa mensual de avances en % (máx. 4 decimales)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4 })
  tasaInteresAvance?: number | string;

  @ApiPropertyOptional({ example: '25000', description: 'Cuota de manejo (máx. 2 decimales)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2 })
  cuotaManejo?: number | string;

  @ApiPropertyOptional({ example: 'https://www.bancolombia.com/tarifas' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  urlInfo?: string;

  @ApiPropertyOptional({ example: true, description: 'Incluir esta tarjeta al actualizar tasas por web scraping' })
  @IsOptional()
  @IsBoolean()
  extractTasas?: boolean;
}
