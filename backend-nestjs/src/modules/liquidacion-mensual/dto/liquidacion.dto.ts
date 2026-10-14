import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsPositive, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Filtros de `GET /api/liquidacion-mensual/:periodo`. */
export class FiltroLiquidacionDto {
  @ApiPropertyOptional({ description: 'Solo esta persona' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @IsPositive()
  personaId?: number;

  @ApiPropertyOptional({ description: 'true = incluye también a las personas sin movimientos ni saldo en el mes' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  todas?: boolean;
}

/** `POST /api/liquidacion-mensual/cruce-entre-personas` */
export class CruceEntrePersonasDto {
  @ApiProperty({ description: 'Persona a quien se le DISMINUYE lo que debe (recibe el abono)' })
  @IsInt()
  @IsPositive()
  personaOrigenId: number;

  @ApiProperty({ description: 'Persona que ASUME la deuda frente a ti (recibe el cargo)' })
  @IsInt()
  @IsPositive()
  personaDestinoId: number;

  @ApiProperty({ example: '100000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Mes del cruce; por defecto el de la fecha (o el actual)' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiPropertyOptional({ example: '2026-10-14' })
  @IsOptional()
  @Matches(FECHA, { message: 'fecha debe tener formato yyyy-MM-dd' })
  fecha?: string;

  @ApiProperty({ example: 'Andrés le debía a mi papá lo de un arreglo' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  concepto: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comentarios?: string;

  @ApiPropertyOptional({ description: 'Préstamo al que se aplica el abono' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  prestamoDestinoId?: number;
}

/** `POST /api/liquidacion-mensual/registrar-pago` */
export class RegistrarPagoMesDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: '250000.00', description: 'Pago parcial o total de lo que la persona debe' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Mes del estado de cuenta al que se imputa; por defecto el actual' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiPropertyOptional({ description: 'Cuenta donde entra el dinero (genera una transacción y mueve su saldo). Si falta, solo se anota el abono' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaDestinoId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  concepto?: string;

  @ApiPropertyOptional({ description: 'Requiere cuentaDestinoId: marca Pagados los préstamos pendientes de ese corte' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  liquidarPrestamosCorteId?: number;
}
