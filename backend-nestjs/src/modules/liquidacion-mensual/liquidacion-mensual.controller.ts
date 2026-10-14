import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CruceEntrePersonasDto, FiltroLiquidacionDto, RegistrarPagoMesDto } from './dto/liquidacion.dto';
import { LiquidacionMensualService } from './liquidacion-mensual.service';

/** «¿Cuánto me debe cada persona a fin de mes?» Consolidado del sub-ledger + cuota del carro. También en `/api/v2/liquidacion-mensual/*`. */
@ApiTags('Liquidación mensual')
@ApiBearerAuth()
@Controller('api/liquidacion-mensual')
export class LiquidacionMensualController {
  constructor(private readonly liquidacion: LiquidacionMensualService) {}

  @Post('cruce-entre-personas')
  @HttpCode(201)
  @ApiOperation({ summary: 'Cruce directo entre dos personas: abona a una y carga a la otra (un solo INSERT, Trigger 5)' })
  cruce(@Body() dto: CruceEntrePersonasDto, @CurrentUser('userId') userId: bigint) {
    return this.liquidacion.cruceEntrePersonas(dto, userId);
  }

  @Post('registrar-pago')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registra el pago (parcial o total) de lo que una persona debe; con cuenta destino también mueve su saldo' })
  pago(@Body() dto: RegistrarPagoMesDto, @CurrentUser('userId') userId: bigint) {
    return this.liquidacion.registrarPago(dto, userId);
  }

  @Get(':periodo')
  @ApiOperation({
    summary:
      'Liquidación del mes YYYY-MM por persona: cuotas de tarjeta, préstamos, recurrentes, cruces, cuota del carro, abonos y saldo neto. Genera antes los recurrentes del mes',
  })
  mes(@Param('periodo') periodo: string, @Query() filtro: FiltroLiquidacionDto, @CurrentUser('userId') userId: bigint) {
    return this.liquidacion.liquidacion(periodo, userId, { personaId: filtro.personaId, todas: filtro.todas });
  }

  @Get(':periodo/persona/:personaId')
  @ApiOperation({ summary: 'Liquidación del mes de una sola persona' })
  persona(@Param('periodo') periodo: string, @Param('personaId', ParseIntPipe) personaId: number, @CurrentUser('userId') userId: bigint) {
    return this.liquidacion.liquidacionPersona(periodo, personaId, userId);
  }
}
