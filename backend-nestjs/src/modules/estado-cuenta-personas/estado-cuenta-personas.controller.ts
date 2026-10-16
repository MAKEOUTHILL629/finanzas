import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EstadoCuentaPersonasService } from './estado-cuenta-personas.service';

/**
 * Estado de cuenta por persona: lo que debe pagar este mes, su deuda total y de qué compras de qué tarjeta sale.
 * Las rutas estáticas van antes de la paramétrica.
 */
@ApiTags('Personas · estado de cuenta')
@ApiBearerAuth()
@Controller('api/personas')
export class EstadoCuentaPersonasController {
  constructor(private readonly estado: EstadoCuentaPersonasService) {}

  @Get('estado-cuenta')
  @ApiOperation({ summary: 'Resumen de cada persona: pago del mes, saldo exigible, por vencer y deuda total, con el total por tarjeta' })
  @ApiQuery({ name: 'periodo', required: false, example: '2026-10', description: 'YYYY-MM; por defecto el mes actual' })
  @ApiQuery({ name: 'todas', required: false, type: Boolean, description: 'true = incluye personas sin deuda ni movimientos' })
  listar(@Query('periodo') periodo: string | undefined, @Query('todas') todas: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.estado.listar(userId, periodo || undefined, { todas: todas === 'true' });
  }

  @Get(':id/estado-cuenta')
  @ApiOperation({ summary: 'Estado de cuenta de una persona: compras con tarjeta (cuota k de N, porcentaje, saldadas), préstamos, recurrentes, cruces y abonos' })
  @ApiQuery({ name: 'periodo', required: false, example: '2026-10' })
  detalle(@Param('id', ParseIntPipe) id: number, @Query('periodo') periodo: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.estado.detalle(userId, id, periodo || undefined);
  }
}
