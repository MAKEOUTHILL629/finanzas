import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ModalidadAporteCuota } from './aportes-cuota.calc';
import { AportesCuotaService } from './aportes-cuota.service';

@ApiTags('Compras a crédito')
@ApiBearerAuth()
@Controller('api/compras-credito')
export class AportesCuotaController {
  constructor(private readonly aportes: AportesCuotaService) {}

  @Get(':id/cuotas-colaborativas')
  @ApiOperation({ summary: 'Cuotas de la compra con aportes colaborativos: cuánto te toca a ti y qué falta entregar al titular (Fase 5)' })
  listar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.aportes.listarPorCompra(id, userId);
  }

  @Post('cuotas/:cuotaId/aportes')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registra una ayuda/aporte variable de un familiar a esta cuota (o tu pago al titular)' })
  registrar(
    @Param('cuotaId', ParseIntPipe) cuotaId: number,
    @Body() dto: { aportantePersonaId: number; monto: number | string; fecha?: string; modalidad?: ModalidadAporteCuota; observaciones?: string; comprobanteUrl?: string },
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.aportes.registrarAporte(cuotaId, userId, dto);
  }
}
