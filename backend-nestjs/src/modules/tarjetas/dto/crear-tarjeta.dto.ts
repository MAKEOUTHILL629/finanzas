import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';
import { MOTIVOS_REEMPLAZO, MotivoReemplazo } from '../plasticos.util';
import { TIPOS_TARJETA, TipoTarjeta } from '../tipos-tarjeta.util';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MSG_FECHA = 'La fecha debe tener formato yyyy-MM-dd';

/**
 * `POST /api/tarjetas` — crea una tarjeta (con su primer plástico) o, con `plasticoAnteriorId`, el plástico que RENUEVA a otro:
 * el anterior queda archivado (conserva su historial) y el nuevo pasa a ser el vigente de la misma línea.
 * No bloquea por cuenta ni por franquicia: una cuenta puede tener varias tarjetas.
 */
export class CrearTarjetaDto {
  @ApiProperty({ enum: TIPOS_TARJETA, example: 'DEBITO' })
  @IsIn([...TIPOS_TARJETA])
  tipo: TipoTarjeta;

  @ApiPropertyOptional({ example: 7, description: 'Cuenta a la que pertenece. Obligatoria en las tarjetas de débito; en crédito es la cuenta que la paga (opcional)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  cuentaId?: number;

  @ApiPropertyOptional({ example: '7992', description: 'Últimos 4 dígitos del plástico. Solo puede faltar en un producto «sin número» (esGenerica)' })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'ultimos4 debe tener exactamente 4 dígitos' })
  ultimos4?: string;

  @ApiPropertyOptional({ example: 'Visa', description: 'Franquicia (Visa, Mastercard, American Express…)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  franquicia?: string;

  @ApiPropertyOptional({ example: 'Débito *3698', description: 'Nombre corto para mostrar' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  alias?: string;

  @ApiPropertyOptional({ example: 'Oro' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  descripcion?: string;

  @ApiPropertyOptional({ enum: ['ACTIVA', 'INACTIVA'], default: 'ACTIVA', description: 'INACTIVA = histórica (ya no se usa); se registra sin ser el plástico vigente' })
  @IsOptional()
  @IsIn(['ACTIVA', 'INACTIVA'])
  estado?: 'ACTIVA' | 'INACTIVA';

  @ApiPropertyOptional({ example: '2026-09-19', description: 'Desde cuándo se usa (por defecto, hoy si es activa)' })
  @IsOptional()
  @Matches(FECHA, { message: MSG_FECHA })
  fechaInicioUso?: string;

  @ApiPropertyOptional({ example: '2027-01-31', description: 'Hasta cuándo se usó (solo histórica)' })
  @IsOptional()
  @Matches(FECHA, { message: MSG_FECHA })
  fechaFinUso?: string;

  @ApiPropertyOptional({ example: 12, description: 'Plástico al que reemplaza (renovación): el nuevo entra en la misma línea y el anterior se archiva' })
  @IsOptional()
  @IsInt()
  @Min(1)
  plasticoAnteriorId?: number;

  @ApiPropertyOptional({ enum: MOTIVOS_REEMPLAZO, description: 'Motivo del reemplazo (solo con plasticoAnteriorId)' })
  @IsOptional()
  @IsIn([...MOTIVOS_REEMPLAZO])
  motivo?: MotivoReemplazo;

  @ApiPropertyOptional({ description: 'Producto «sin número»: recibe los avisos del banco que no traen los últimos 4 dígitos' })
  @IsOptional()
  @IsBoolean()
  esGenerica?: boolean;

  @ApiPropertyOptional({ example: 15, description: 'Día de corte del extracto (solo crédito)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaCorte?: number;

  @ApiPropertyOptional({ example: 5, description: 'Día límite de pago (solo crédito)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaLimitePago?: number;

  @ApiPropertyOptional({ example: '12000000.00', description: 'Cupo total (solo crédito)' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  cupoTotal?: number | string;

  @ApiPropertyOptional({ example: 'Se perdió en un viaje' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;

  @ApiPropertyOptional({ description: 'Tarjeta prestada/de un tercero (Fase 5): no suma al cupo propio' })
  @IsOptional()
  @IsBoolean()
  esTitularExterno?: boolean;

  @ApiPropertyOptional({ example: 5, description: 'Persona titular de la tarjeta prestada (ej. Mamá)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  titularPersonaId?: number;
}
