import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos, parseIntStrict } from '../../common/utils/legacy-http.util';
import { PagosService } from './pagos.service';

/** Rutas `/api/tarjetas/pagos*` (viven en `ComprasCreditoControlador.scala`). */
@ApiTags('Tarjetas')
@ApiBearerAuth()
@Controller('api/tarjetas/pagos')
export class PagosTarjetaController {
  constructor(private readonly pagos: PagosService) {}

  @Get()
  pagoTotalMes(@CurrentUser('userId') userId: bigint) {
    return this.pagos.calcularPagoTarjetasCredito(userId);
  }

  @Get(':id')
  @ApiQuery({ name: 'mes', required: true, type: Number })
  @ApiQuery({ name: 'year', required: true, type: Number })
  async detalle(
    @Param('id', ParseIntPipe) tarjetaId: number,
    @Query('mes') mesRaw: string | undefined,
    @Query('year') yearRaw: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    const mes = parseIntStrict(mesRaw);
    const year = parseIntStrict(yearRaw);
    if (mes === null || year === null || mes < 1 || mes > 12 || year < 1) throw datosInvalidos();
    return this.pagos.calcularPagoTarjetaCreditoDetalle(tarjetaId, year, mes, userId);
  }
}
