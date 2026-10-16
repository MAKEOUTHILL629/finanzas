import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen ejecutivo de la pantalla de inicio en una sola llamada',
    description:
      'Liquidez y patrimonio, flujo del mes (ingresos vs. gastos propios), tarjetas (mi parte vs. terceros, cupo, próximo vencimiento), ' +
      'lo que te deben las personas con los principales deudores, próximos vencimientos, movimientos recientes y alertas.',
  })
  @ApiQuery({ name: 'periodo', required: false, example: '2026-10', description: 'YYYY-MM; por defecto el mes actual' })
  summary(@Query('periodo') periodo: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.dashboard.resumen(userId, periodo || undefined);
  }
}
