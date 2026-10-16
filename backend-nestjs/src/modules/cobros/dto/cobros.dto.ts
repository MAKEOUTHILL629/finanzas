import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const CATEGORIAS_COBRO = ['SERVICIO', 'MERCADO', 'EVENTO', 'OTRO'] as const;
export const MODOS_DIVISION = ['IGUAL', 'PORCENTAJE', 'MONTO'] as const;

export class ParticipanteCobroDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiPropertyOptional({ description: 'Modo MONTO: lo que le toca a esta persona' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  monto?: number | string;

  @ApiPropertyOptional({ description: 'Modo PORCENTAJE: % del total (0–100)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 4, positive: true })
  porcentaje?: number | string;
}

/** `POST/PUT /api/cobros-puntuales`: un gasto que se reparte entre varias personas (la luz, el mercado, una fiesta…). */
export class GuardarCobroPuntualDto {
  @ApiProperty({ example: 'Recibo de la luz octubre' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  concepto: string;

  @ApiPropertyOptional({ enum: CATEGORIAS_COBRO, default: 'OTRO' })
  @IsOptional()
  @IsIn(CATEGORIAS_COBRO as unknown as string[])
  categoria?: (typeof CATEGORIAS_COBRO)[number];

  @ApiProperty({ example: '2026-10-14', description: 'Cuándo se hizo el gasto' })
  @Matches(FECHA, { message: 'fechaGasto debe tener formato yyyy-MM-dd' })
  fechaGasto: string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Mes de la liquidación en que se cobra; por defecto el de la fecha' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiProperty({ example: '184500.00', description: 'Lo que costó en total' })
  @IsMoney({ maxDecimals: 2, positive: true })
  montoTotal: number | string;

  @ApiPropertyOptional({ enum: MODOS_DIVISION, default: 'IGUAL' })
  @IsOptional()
  @IsIn(MODOS_DIVISION as unknown as string[])
  modoDivision?: (typeof MODOS_DIVISION)[number];

  @ApiProperty({ type: [ParticipanteCobroDto], description: 'Quiénes participan. Si te incluyes, tu parte no genera deuda.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ParticipanteCobroDto)
  participantes: ParticipanteCobroDto[];

  @ApiPropertyOptional({ description: 'Transacción de tu cuenta con la que pagaste el gasto' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  transaccionId?: number;

  @ApiPropertyOptional({ description: 'Compra de tarjeta con la que pagaste el gasto' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  compraCreditoId?: number;

  @ApiPropertyOptional({ description: 'Correo del banco del que nace el cobro' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  notificacionId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notas?: string;
}

export class FiltroCobrosDto {
  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiPropertyOptional({ enum: ['ACTIVO', 'ANULADO', 'TODOS'], default: 'ACTIVO' })
  @IsOptional()
  @IsIn(['ACTIVO', 'ANULADO', 'TODOS'])
  estado?: 'ACTIVO' | 'ANULADO' | 'TODOS';
}

// ───────────────────────────── enlaces ─────────────────────────────

/** `POST /api/cobros/enlaces`: genera (o actualiza) el enlace que se comparte con la persona. */
export class GenerarEnlaceDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: '2026-10' })
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;

  @ApiPropertyOptional({ example: 'Hola Andrés, este es el resumen del mes 🙌' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  mensaje?: string;

  @ApiPropertyOptional({ example: 'Bre-B a @luish9910 o Bancolombia ahorros *3698' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  instruccionesPago?: string;

  @ApiPropertyOptional({ default: 45, description: 'Días que el enlace sigue vigente (1–180)' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @IsPositive()
  diasVigencia?: number;

  @ApiPropertyOptional({ description: 'true = genera un token nuevo (el enlace anterior deja de funcionar)' })
  @IsOptional()
  @IsBoolean()
  rotarToken?: boolean;
}

export class FiltroEnlacesDto {
  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;
}

// ───────────────────────────── pagos reportados ─────────────────────────────

export const MEDIOS_PAGO = ['TRANSFERENCIA', 'BREB', 'NEQUI', 'DAVIPLATA', 'EFECTIVO', 'OTRO'] as const;

export class ComprobanteDto {
  @ApiProperty({ example: 'comprobante.jpg' })
  @IsString()
  @MaxLength(160)
  nombre: string;

  @ApiProperty({ example: 'image/jpeg', description: 'image/jpeg, image/png, image/webp o application/pdf' })
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  tipo: string;

  @ApiProperty({ description: 'Contenido en base64 (máx. ~2.4 MB ya decodificado)' })
  @IsString()
  @MaxLength(3_500_000)
  datos: string;
}

/** `POST /api/publico/cobros/:token/pagos` — lo envía la persona desde el enlace, sin iniciar sesión. */
export class ReportarPagoDto {
  @ApiProperty({ example: '250000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiProperty({ example: '2026-10-30', description: 'Cuándo hizo la transferencia' })
  @Matches(FECHA, { message: 'fechaPago debe tener formato yyyy-MM-dd' })
  fechaPago: string;

  @ApiPropertyOptional({ enum: MEDIOS_PAGO })
  @IsOptional()
  @IsIn(MEDIOS_PAGO as unknown as string[])
  medio?: (typeof MEDIOS_PAGO)[number];

  @ApiPropertyOptional({ description: 'Referencia o número de aprobación de la transferencia' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comentario?: string;

  @ApiPropertyOptional({ type: ComprobanteDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ComprobanteDto)
  comprobante?: ComprobanteDto;
}

export class FiltroReportesDto {
  @ApiPropertyOptional({ enum: ['PENDIENTE', 'APROBADO', 'RECHAZADO'] })
  @IsOptional()
  @IsIn(['PENDIENTE', 'APROBADO', 'RECHAZADO'])
  estado?: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';

  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;
}

export class AprobarReporteDto {
  @ApiPropertyOptional({ description: 'Monto que sí llegó (por defecto, el reportado)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  monto?: number | string;

  @ApiPropertyOptional({ description: 'Cuenta donde recibiste el dinero: se registra el ingreso y se mueve su saldo' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaDestinoId?: number;

  @ApiPropertyOptional({ description: 'Transacción de ingreso que YA existe (p. ej. detectada por correo): se enlaza sin crear otra' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  transaccionId?: number;
}

export class RechazarReporteDto {
  @ApiProperty({ example: 'No veo la transferencia en mi cuenta' })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  motivo: string;
}

/** `POST /api/cobros/pagos/aplicar-ingreso`: aplica como pago de una persona un ingreso que ya está en tus cuentas. */
export class AplicarIngresoDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  transaccionId: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiProperty({ example: '2026-10', description: 'Mes de la liquidación al que se abona' })
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;

  @ApiPropertyOptional({ description: 'Solo una parte del ingreso (por defecto, todo)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  monto?: number | string;
}
