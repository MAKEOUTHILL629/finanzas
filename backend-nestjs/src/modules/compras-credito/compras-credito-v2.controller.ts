import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { legacyTry } from '../../common/utils/legacy-http.util';
import { ComprasCreditoService } from './compras-credito.service';
import { ConfirmarTrmDto, PatchCompraCreditoDto, PropagarEdicionSimilaresDto } from './dto/compra-credito.dto';

/** ERP v2 — compras multimoneda, edición 360°, detalle enriquecido y propagación a compras similares. */
@ApiTags('Compras Crédito v2')
@ApiBearerAuth()
@Controller(['api/compras-credito', 'api/v2/compras-credito'])
export class ComprasCreditoV2Controller {
  constructor(private readonly compras: ComprasCreditoService) {}

  @Get(':id/detalle-completo')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @ApiOperation({
    summary: 'Detalle 360° enriquecido de una compra a crédito (tarjeta, plástico, responsables, correo original, refinanciamiento, recurrencia y estadísticas del comercio)',
  })
  async detalleCompleto(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return (await this.compras.getDetalleCompleto(id, userId)) ?? 'null';
  }

  @Post(':id/buscar-similares')
  @ApiOperation({
    summary: 'Detecta compras similares del mismo comercio para ofrecer propagación de cuotas, responsables y tags',
  })
  buscarSimilares(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.compras.buscarComprasSimilaresParaPropagacion(id, userId);
  }

  @Patch('propagar-edicion-similares')
  @ApiOperation({
    summary: 'Propaga selectivamente cuotas, responsables porcentuales, tags y comercio canónico a las compras similares seleccionadas',
  })
  propagarSimilares(@Body() dto: PropagarEdicionSimilaresDto, @CurrentUser('userId') userId: bigint) {
    return this.compras.propagarEdicionSimilares(dto, userId);
  }

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

  @Patch(':id')
  @ApiOperation({
    summary: 'Edición en línea del detalle de una compra: cambia solo lo enviado',
    description:
      'Concepto, descripción, estado, plástico, tags y comercio canónico son una actualización simple. Valor, cuotas, interés, fecha o tarjeta recalculan las cuotas ' +
      'y no se permiten en una compra ya unificada en un refinanciamiento (409).',
  })
  parcial(@Param('id', ParseIntPipe) id: number, @Body() dto: PatchCompraCreditoDto, @CurrentUser('userId') userId: bigint) {
    return this.compras.patchCompra(id, dto, userId);
  }
}
