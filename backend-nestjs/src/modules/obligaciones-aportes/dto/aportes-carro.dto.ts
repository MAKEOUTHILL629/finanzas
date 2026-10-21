import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DestinoExcedente, MetodoAporte, TipoObligacionMes } from '../../../common/enums/finance.enums';
import { IsMoney } from '../../../common/validators/is-money.decorator';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Una línea del desglose de un aporte diario (el sub-formulario «Aportes Carro Form» de AppSheet). */
export class DetalleAporteDiarioDto {
  @ApiPropertyOptional({ description: 'Solo en PUT: id del detalle existente (si no cambia, se conserva su cruce y su transacción)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  id?: number;

  @ApiProperty({ example: '358000.00' })
  @IsMoney({ maxDecimals: 2, positive: true })
  valor: number | string;

  @ApiProperty({ enum: MetodoAporte, example: MetodoAporte.EFECTIVO })
  @IsIn(Object.values(MetodoAporte))
  metodo: MetodoAporte;

  @ApiProperty({
    description:
      'EFECTIVO/TRANSFERENCIA/SALDO_A_FAVOR: el responsable (papá) o tú. CRUCE_CUENTAS: la persona que asume la deuda (ej. Andrés): el valor suma a la cuota y se le carga a ella',
  })
  @IsInt()
  @IsPositive()
  personaId: number;

  @ApiPropertyOptional({ description: 'Solo EFECTIVO/TRANSFERENCIA: cuenta donde entra el dinero (si falta, la cuenta EFECTIVO por defecto)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaFinancieraId?: number;

  @ApiPropertyOptional({ enum: ['EFECTIVO', 'TRANSFERENCIA'], description: 'Fase 6: clasificación binaria del aporte; por defecto se deriva del método' })
  @IsOptional()
  @IsIn(['EFECTIVO', 'TRANSFERENCIA'])
  medioPago?: 'EFECTIVO' | 'TRANSFERENCIA';

  @ApiPropertyOptional({ description: 'Fase 6 · TRANSFERENCIA: cuenta destino cuando difiere de cuentaFinancieraId' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  cuentaDestinoId?: number;

  @ApiPropertyOptional({ description: 'Fase 6 · TRANSFERENCIA: transacción bancaria entrante existente a asociar (no se crea otra)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  transaccionId?: number;

  @ApiPropertyOptional({ example: 'Andrés le debía a mi papá lo de un arreglo' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comentarios?: string;

  @ApiPropertyOptional({ description: 'Solo SALDO_A_FAVOR: periodo (ObligacionesMes) del que sale el excedente; por defecto el mes anterior' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  origenObligacionMesId?: number;
}

/** `POST /api/obligaciones-aportes/aportes-diarios` */
export class CrearAporteDiarioDto {
  @ApiProperty({ example: '2026-10-14' })
  @Matches(FECHA, { message: 'fecha debe tener formato yyyy-MM-dd' })
  fecha: string;

  @ApiPropertyOptional({ example: '2026-09', description: 'Mes de la cuota al que abona (puede ser distinto al de la fecha). Por defecto, el mes de la fecha' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo?: string;

  @ApiPropertyOptional({ description: 'Alternativa a `periodo`: id del periodo (ObligacionesMes) destino' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  obligacionMesId?: number;

  @ApiPropertyOptional({ enum: TipoObligacionMes, default: TipoObligacionMes.CUOTA_CARRO })
  @IsOptional()
  @IsEnum(TipoObligacionMes)
  tipoObligacion?: TipoObligacionMes;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiProperty({ type: [DetalleAporteDiarioDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DetalleAporteDiarioDto)
  detalles: DetalleAporteDiarioDto[];
}

/** `PUT /api/obligaciones-aportes/aportes-diarios/:id` — reemplaza el día; los detalles con `id` que no cambian se conservan. */
export class ActualizarAporteDiarioDto extends CrearAporteDiarioDto {}

/** `POST /api/obligaciones-aportes/periodos` — crea o configura la cuota objetivo de un mes. */
export class GuardarPeriodoDto {
  @ApiProperty({ example: '2026-09' })
  @Matches(PERIODO, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;

  @ApiProperty({ example: '1400000.00', description: 'Valor de la cuota objetivo del mes' })
  @IsMoney({ maxDecimals: 2, positive: true })
  valorCuota: number | string;

  @ApiPropertyOptional({ enum: TipoObligacionMes, default: TipoObligacionMes.CUOTA_CARRO })
  @IsOptional()
  @IsEnum(TipoObligacionMes)
  tipoObligacion?: TipoObligacionMes;

  @ApiPropertyOptional({ description: 'Responsable de la cuota; por defecto el del último periodo del mismo tipo' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  responsablePrincipalId?: number;

  @ApiPropertyOptional({ example: 'Septiembre 2026', description: 'Etiqueta legible; por defecto «Mes año»' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  concepto?: string;
}

/** `POST /api/obligaciones-aportes/periodos/:id/aplicar-excedente` */
export class AplicarExcedenteDto {
  @ApiProperty({ enum: DestinoExcedente, description: 'SIGUIENTE_MES: aporte SALDO_A_FAVOR en el mes siguiente. ESTADO_CUENTA: abono en el estado de cuenta de fin de mes del responsable' })
  @IsEnum(DestinoExcedente)
  destino: DestinoExcedente;

  @ApiPropertyOptional({ example: '50000.00', description: 'Por defecto, todo el saldo a favor disponible' })
  @IsOptional()
  @IsMoney({ maxDecimals: 2, positive: true })
  valor?: number | string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Solo ESTADO_CUENTA: mes del estado de cuenta; por defecto el mes actual' })
  @IsOptional()
  @Matches(PERIODO, { message: 'periodoImputacion debe tener formato YYYY-MM' })
  periodoImputacion?: string;
}
