import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsPositive, IsString, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';
import { EnteroOpcional, VacioAUndefined } from '../../../common/validators/normalizar-opcional.decorator';
import { ACCIONES_OBJECION, AccionObjecion, TIPOS_METODO_PAGO, TipoMetodoPago } from '../ajustes-cobro.util';
import { ComprobanteDto } from './cobros.dto';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

// ───────────────────────────── medios de pago ─────────────────────────────

export class CrearMetodoPagoDto {
  @ApiProperty({ enum: TIPOS_METODO_PAGO })
  @IsIn(TIPOS_METODO_PAGO as unknown as string[])
  tipo: TipoMetodoPago;

  @ApiProperty({ example: 'Bancolombia' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  entidad: string;

  @ApiProperty({ example: '123-456789-01', description: 'Número de cuenta, celular o llave' })
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  numero: string;

  @ApiPropertyOptional({ example: 'Felipe Hernández' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  titular?: string;

  @ApiPropertyOptional({ description: 'Documento del titular (algunos bancos lo piden para transferir)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  documento?: string;

  @ApiPropertyOptional({ example: 'Pon tu nombre en la descripción' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instrucciones?: string;

  @ApiPropertyOptional({ description: 'Cuenta de la app a la que corresponde (opcional)' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaId?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ description: 'Posición en la lista (menor = primero)' })
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @Min(0)
  orden?: number;
}

/** `PATCH /api/metodos-pago/:id`: solo cambia lo que se envía (`null` o vacío en un opcional lo borra). */
export class ActualizarMetodoPagoDto {
  @ApiPropertyOptional({ enum: TIPOS_METODO_PAGO })
  @IsOptional()
  @IsIn(TIPOS_METODO_PAGO as unknown as string[])
  tipo?: TipoMetodoPago;

  @ApiPropertyOptional()
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entidad?: string;

  @ApiPropertyOptional()
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  numero?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  titular?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  documento?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instrucciones?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @EnteroOpcional()
  @IsOptional()
  @IsInt()
  @Min(0)
  orden?: number;
}

/** `PUT /api/metodos-pago/:id/qr` — imagen del QR (base64, como el comprobante pero solo imágenes). */
export class QrMetodoPagoDto {
  @ApiProperty({ type: ComprobanteDto })
  @ValidateNested()
  @Type(() => ComprobanteDto)
  qr: ComprobanteDto;
}

// ───────────────────────────── observaciones ─────────────────────────────

/** `POST /api/publico/cobros/:token/objeciones` — la persona objeta un renglón o el total de su cobro. */
export class ObjetarCobroDto {
  @ApiProperty({ enum: ['ITEM', 'TOTAL'] })
  @IsIn(['ITEM', 'TOTAL'])
  alcance: 'ITEM' | 'TOTAL';

  @ApiPropertyOptional({ description: 'Alcance ITEM: la `clave` del renglón que aparece en el detalle' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  itemClave?: string;

  @ApiProperty({ example: 'Ya te había abonado $50.000 de esto', description: 'Obligatorio: sin comentario no se registra' })
  @IsString()
  @MinLength(3, { message: 'Cuéntanos qué pasa con este cobro (mínimo 3 letras)' })
  @MaxLength(1000)
  comentario: string;

  @ApiPropertyOptional({ description: 'Lo que la persona cree que debe (opcional)' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2 })
  montoPropuesto?: number | string;
}

export class FiltroObjecionesDto {
  @ApiPropertyOptional({ enum: ['ABIERTA', 'RESUELTA'] })
  @IsOptional()
  @IsIn(['ABIERTA', 'RESUELTA'])
  estado?: 'ABIERTA' | 'RESUELTA';

  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;
}

/** `POST /api/cobros/objeciones/:id/resolver` */
export class ResolverObjecionDto {
  @ApiProperty({ enum: ACCIONES_OBJECION })
  @IsIn(ACCIONES_OBJECION as unknown as string[])
  accion: AccionObjecion;

  @ApiPropertyOptional({ description: 'AJUSTAR: el monto nuevo a cobrar por ese renglón. DESCUENTO: lo que se descuenta del saldo.' })
  @VacioAUndefined()
  @IsOptional()
  @IsMoney({ maxDecimals: 2 })
  monto?: number | string;

  @ApiPropertyOptional({ example: 'Tienes razón, ese abono no lo había registrado', description: 'Lo ve la persona en su enlace (obligatorio al mantener el cobro)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  respuesta?: string;
}

/** `POST /api/cobros/enlaces/:id/descuento` — descuento directo sobre el saldo, sin que haya una observación. */
export class DescuentoDirectoDto {
  @ApiProperty({ example: '50000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  monto: number | string;

  @ApiProperty({ example: 'Gasto que no era suyo' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo: string;
}
