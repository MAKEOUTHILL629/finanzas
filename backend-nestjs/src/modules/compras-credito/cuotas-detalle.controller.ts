import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CuotasDetalleService } from './cuotas-detalle.service';

/**
 * `GET /api/compras-credito/:id` → cuotas de la compra (`CuotaDetalleControlador.listById`).
 * Se registra DESPUÉS de las rutas estáticas de ComprasCreditoController (módulo importado en ese orden).
 */
@ApiTags('Cuotas')
@ApiBearerAuth()
@Controller('api/compras-credito')
export class CuotasDetalleController {
  constructor(private readonly cuotas: CuotasDetalleService) {}

  @Get(':id')
  listByCompra(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.cuotas.listByCompra(id, userId);
  }
}
