import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProductosFinancierosService } from './productos-financieros.service';

@ApiTags('Productos financieros')
@ApiBearerAuth()
@Controller('api/productos-financieros')
export class ProductosFinancierosController {
  constructor(private readonly productos: ProductosFinancierosService) {}

  @Get('linea-tiempo')
  @ApiOperation({ summary: 'Periodo de uso de cada tarjeta (por plástico) y cada cuenta, con su cantidad de movimientos y monto' })
  lineaTiempo(@CurrentUser('userId') userId: bigint) {
    return this.productos.lineaTiempo(userId);
  }
}
