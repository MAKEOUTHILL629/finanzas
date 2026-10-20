import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
} from 'class-validator';
import {
  DireccionPrestamo,
  EstadoAprobacion,
  EstadoCorte,
  EstadoPrestamo,
  MetodoPrestamo,
} from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FECHA_MSG = 'La fecha debe tener formato yyyy-MM-dd';

/** `POST /api/prestamos` (contrato legacy) y `POST /api/v2/prestamos` (con campos ERP opcionales). */
export class CreatePrestamoDto {
  @ApiProperty({ example: 500000 })
  @IsNumber()
  valorPrestado: number | string;

  @ApiProperty({ example: 'Préstamo para viaje' })
  @IsString()
  concepto: string;

  @ApiProperty({ example: '2024-06-01', description: 'Fecha estimada de pago (yyyy-MM-dd; se ignora cualquier sufijo, como el legacy)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}/, { message: FECHA_MSG })
  fechaCobro: string;

  @ApiProperty({ example: 2, description: 'ID de la persona deudora' })
  @IsInt()
  responsable: number;

  @ApiProperty({ example: 'Pendiente' })
  @IsString()
  estado: string;

  @ApiProperty({ example: '' })
  @IsString()
  comentarios: string;

  @ApiPropertyOptional({ enum: DireccionPrestamo, description: "Por defecto 'POR_COBRAR'" })
  @IsOptional()
  @IsEnum(DireccionPrestamo)
  direccionPrestamo?: DireccionPrestamo;

  @ApiPropertyOptional({ example: '2024-05-20', description: 'Fecha real del préstamo (default: hoy)' })
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaPrestamo?: string;

  @ApiPropertyOptional({ enum: MetodoPrestamo })
  @IsOptional()
  @IsEnum(MetodoPrestamo)
  metodo?: MetodoPrestamo;

  @ApiPropertyOptional({ description: 'Corte de cobro; si se omite se busca el corte activo' })
  @IsOptional()
  @IsInt()
  corteId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  esRecurrenteMensual?: boolean;

  @ApiPropertyOptional({ example: '2026-11-15', description: 'Fecha compromiso de pago (préstamos POR_PAGAR, Fase 6)' })
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaCompromisoPago?: string;

  @ApiPropertyOptional({ example: 'Nequi 3001234567 - Cuñada', description: 'Cuenta/billetera destino del acreedor (Fase 6)' })
  @IsOptional()
  @IsString()
  cuentaDestinoTercero?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  cuotaMensualAcordada?: number | string;
}

/** `PATCH /api/v2/prestamos/:id` */
export class UpdatePrestamoDto {
  @ApiPropertyOptional({ enum: EstadoPrestamo })
  @IsOptional()
  @IsEnum(EstadoPrestamo)
  estado?: EstadoPrestamo;

  @ApiPropertyOptional({ description: 'Saldo pendiente tras abonos parciales' })
  @IsOptional()
  @IsNumber()
  saldoPendiente?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comentarios?: string;

  @ApiPropertyOptional({ enum: MetodoPrestamo })
  @IsOptional()
  @IsEnum(MetodoPrestamo)
  metodo?: MetodoPrestamo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  corteId?: number;

  @ApiPropertyOptional({ example: '2024-06-01' })
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaCobro?: string;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaCompromisoPago?: string;

  @ApiPropertyOptional({ example: 'Nequi 3001234567 - Cuñada' })
  @IsOptional()
  @IsString()
  cuentaDestinoTercero?: string;
}

/** `POST /api/v2/prestamos/:id/abonos-con-comprobante` (Fase 6) */
export class AbonoPrestamoPasivoDto {
  @ApiProperty({ example: '200000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiPropertyOptional({ example: 'Nequi 3001234567 - Cuñada', description: 'Cuenta de ella a la que se envió (por defecto, la del préstamo)' })
  @IsOptional()
  @IsString()
  cuentaDestinoDetalle?: string;

  @ApiPropertyOptional({ description: 'Cuenta tuya desde la que salió el dinero (crea el egreso)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaOrigenId?: number;

  @ApiPropertyOptional({ description: 'Comprobante en base64: { nombre, tipo, datos }' })
  @IsOptional()
  comprobante?: { nombre: string; tipo: string; datos: string };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observaciones?: string;
}

/** `PATCH /api/v2/prestamos/:id/aprobaciones/:aprobacionId` */
export class ResolverAprobacionDto {
  @ApiProperty({ enum: [EstadoAprobacion.APROBADO, EstadoAprobacion.RECHAZADO] })
  @IsEnum(EstadoAprobacion)
  estado: EstadoAprobacion;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comentarios?: string;
}

/** `PATCH /api/prestamos/:id/aprobaciones` — sin ids se usa la persona enlazada al usuario autenticado. */
export class ResolverAprobacionPorPersonaDto {
  @ApiPropertyOptional({ description: 'Aprobación concreta (opcional)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  aprobacionId?: number;

  @ApiPropertyOptional({ description: 'Persona que aprueba (default: la persona enlazada a tu usuario)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  personaId?: number;

  @ApiProperty({ enum: [EstadoAprobacion.APROBADO, EstadoAprobacion.RECHAZADO] })
  @IsEnum(EstadoAprobacion)
  estado: EstadoAprobacion;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comentarios?: string;
}

/** `POST /api/cortes-cobro` */
export class CreateCorteCobroDto {
  @ApiProperty({ example: 'Octubre 2026' })
  @IsString()
  concepto: string;

  @ApiProperty({ example: '2026-10-08' })
  @Matches(FECHA, { message: FECHA_MSG })
  fechaInicio: string;

  @ApiProperty({ example: '2026-11-07' })
  @Matches(FECHA, { message: FECHA_MSG })
  fechaFinal: string;

  @ApiPropertyOptional({ enum: EstadoCorte })
  @IsOptional()
  @IsEnum(EstadoCorte)
  estado?: EstadoCorte;
}

/** `PATCH /api/v2/cortes-cobro/:id` */
export class UpdateCorteCobroDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  concepto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaInicio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(FECHA, { message: FECHA_MSG })
  fechaFinal?: string;

  @ApiPropertyOptional({ enum: EstadoCorte })
  @IsOptional()
  @IsEnum(EstadoCorte)
  estado?: EstadoCorte;
}

export class PrestamosFiltroDto {
  @ApiPropertyOptional({ enum: EstadoPrestamo })
  @IsOptional()
  @IsEnum(EstadoPrestamo)
  estado?: EstadoPrestamo;

  @ApiPropertyOptional({ enum: DireccionPrestamo })
  @IsOptional()
  @IsEnum(DireccionPrestamo)
  direccion?: DireccionPrestamo;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  corteId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  responsableId?: number;
}
