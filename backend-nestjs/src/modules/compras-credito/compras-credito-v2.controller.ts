import { Body, Controller, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { legacyTry } from '../../common/utils/legacy-http.util';
import { ComprasCreditoService } from './compras-credito.service';
import { ConfirmarTrmDto } from './dto/compra-credito.dto';

/** ERP v2 — compras multimoneda. */
@ApiTags('Compras Crédito v2')
@ApiBearerAuth()
@Controller('api/compras-credito')
export class ComprasCreditoV2Controller {
  constructor(private readonly compras: ComprasCreditoService) {}

  @Patch(':id/confirmar-trm')
  @ApiOperation({
    summary: 'Confirma la TRM real de una compra en divisa (SELECT sp_actualizar_trm_compra_usd)',
    description:
      'Recalcula las cuotas aún no pagadas; el Trigger 8 sincroniza automáticamente MovimientosDeudaPersona.',
  })
  confirmarTrm(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmarTrmDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return legacyTry('Error al confirmar la TRM', () =>
      this.compras.confirmarTrm(id, userId, dto.nuevaTrm, dto.confirmarDefinitivo ?? true),
    );
  }
}
