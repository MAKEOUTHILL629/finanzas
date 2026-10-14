import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, Matches } from 'class-validator';
import { IsMoney } from '../../../common/validators/is-money.decorator';

/** `POST /api/v2/tarjetas/:id/pagar-extracto` */
export class PagarExtractoDto {
  @ApiProperty({ example: 3, description: 'Cuenta financiera desde la que sale el dinero' })
  @IsInt()
  @IsPositive()
  cuentaOrigenId: number;

  @ApiProperty({ example: '2026-10', description: 'Periodo del extracto (YYYY-MM)' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener formato YYYY-MM' })
  periodo: string;

  @ApiProperty({ example: '1250000.50', description: 'Monto pagado (máx. 2 decimales; número o texto)' })
  @IsMoney({ maxDecimals: 2, positive: true })
  montoPagado: number | string;
}
