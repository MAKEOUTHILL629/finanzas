import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { periodoActual } from '../../common/utils/date.util';
import { datosInvalidos, parseIntStrict } from '../../common/utils/legacy-http.util';
import { ConsultasPagosService } from './consultas-pagos.service';

/** Equivale a `ConsultasPagosControlador.scala`. */
@ApiTags('Pagos')
@ApiBearerAuth()
@Controller('api/pagos/personas')
export class ConsultasPagosController {
  constructor(private readonly consultas: ConsultasPagosService) {}

  @Get()
  listPagosMensualesPersona(@CurrentUser('userId') userId: bigint) {
    return this.consultas.listPagosMensualesPersona(userId);
  }

  /** Sin `mes`/`year` usa el mes actual (igual que el legacy). */
  @Get(':id')
  @ApiQuery({ name: 'mes', required: false, type: Number })
  @ApiQuery({ name: 'year', required: false, type: Number })
  detalleResponsable(
    @Param('id', ParseIntPipe) personaId: number,
    @Query('mes') mesRaw: string | undefined,
    @Query('year') yearRaw: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    let mes: number;
    let year: number;
    if (mesRaw !== undefined && yearRaw !== undefined) {
      const m = parseIntStrict(mesRaw);
      const y = parseIntStrict(yearRaw);
      if (m === null || y === null || m < 1 || m > 12 || y < 1) throw datosInvalidos();
      mes = m;
      year = y;
    } else {
      const [anio, mesActual] = periodoActual().split('-').map((p) => Number.parseInt(p, 10));
      year = anio;
      mes = mesActual;
    }
    return this.consultas.listPagosMensualesPersonaDetalle(personaId, mes, year, userId);
  }
}
