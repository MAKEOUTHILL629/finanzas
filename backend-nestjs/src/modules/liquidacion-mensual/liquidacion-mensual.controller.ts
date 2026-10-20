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

  @Get(':periodo/bilateral')
  @ApiOperation({ summary: 'Cámara bilateral A vs B (Fase 4): dos columnas, saldo anterior como fila #1 y neto a enviar' })
  bilateral(@Param('periodo') periodo: string, @Query('personaId', ParseIntPipe) personaId: number, @CurrentUser('userId') userId: bigint) {
    return this.liquidacion.bilateral(periodo, personaId, userId);
  }

  @Post(':periodo/cerrar-cruce')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cierra el mes: liquida y paga el total, o cierra arrastrando el saldo al periodo siguiente (Fase 4)' })
  cerrarCruce(
    @Param('periodo') periodo: string,
    @Body() dto: { personaId: number; modo: 'LIQUIDAR_Y_PAGAR_TOTAL' | 'CERRAR_Y_ARRASTRAR_SALDO'; cuentaDestinoId?: number },
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.liquidacion.cerrarCruce(periodo, dto.personaId, dto.modo, userId, dto.cuentaDestinoId);
  }

  @Post(':periodo/multa')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registra una multa de convivencia (ej. «Multa por no anotar») a una persona en el periodo (Fase 4)' })
  multa(
    @Param('periodo') periodo: string,
    @Body() dto: { personaId: number; monto: number | string; concepto?: string },
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.liquidacion.registrarMulta(periodo, dto.personaId, dto.monto, userId, dto.concepto);
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
