import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, Matches, MaxLength } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `POST /api/v2/cruces-deuda` — el Trigger 5 genera el par de asientos (-1 y +1). */
export class CreateCruceDeudaDto {
  @ApiPropertyOptional({ example: '2026-10-13', description: 'Por defecto: hoy' })
  @IsOptional()
  @Matches(FECHA, { message: 'fechaCruce debe tener formato yyyy-MM-dd' })
  fechaCruce?: string;

  @ApiProperty({ description: 'Persona a quien se le disminuye la deuda/obligación (p. ej. el papá)' })
  @IsInt()
  @IsPositive()
  personaQueAbonaId: number;

  @ApiProperty({ description: 'Persona a quien se le carga la deuda a tu favor (p. ej. Andrés)' })
  @IsInt()
  @IsPositive()
  personaQueAsumeDeudaId: number;

  @ApiProperty({ example: '100000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiPropertyOptional({ description: 'Préstamo u obligación sobre la que se aplica el abono' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  prestamoDestinoId?: number;

  @ApiPropertyOptional({ description: 'Periodo recurrente sobre el que se aplica el abono' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  periodoRecurrenteDestinoId?: number;

  @ApiProperty({ example: 'Andrés me debe 100.000, descontar de la cuota de la casa' })
  @IsString()
  @MaxLength(255)
  concepto: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comentarios?: string;
}

/** `POST /api/v2/personas/:id/abonar` → `sp_registrar_abono_persona`. */
export class AbonarPersonaDto {
  @ApiProperty({ description: 'Cuenta donde entra el dinero' })
  @IsInt()
  @IsPositive()
  cuentaDestinoId: number;

  @ApiProperty({ example: '350000.50' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiProperty({ example: '2026-10', description: 'Mes contable al que se imputa el abono' })
  @Matches(PERIODO, { message: 'periodoImputacion debe tener formato YYYY-MM' })
  periodoImputacion: string;

  @ApiProperty({ example: 'Pago Nequi octubre' })
  @IsString()
  @MaxLength(255)
  concepto: string;

  @ApiPropertyOptional({ description: "Si se envía, marca como 'Pagado' los préstamos pendientes de la persona en ese corte" })
  @IsOptional()
  @IsInt()
  @IsPositive()
  liquidarPrestamosCorteId?: number;
}
