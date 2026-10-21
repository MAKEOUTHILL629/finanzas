import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AportesCarroService } from './aportes-carro.service';
import { ActualizarAporteDiarioDto, AplicarExcedenteDto, CrearAporteDiarioDto, GuardarPeriodoDto } from './dto/aportes-carro.dto';

/** Aportes diarios del carro, cruces de cuentas y saldo a favor (también disponibles bajo `/api/v2/obligaciones-aportes/*`). */
@ApiTags('Aportes del carro')
@ApiBearerAuth()
@Controller('api/obligaciones-aportes')
export class AportesCarroController {
  constructor(private readonly aportes: AportesCarroService) {}

  @Get('carro/resumen')
  @ApiQuery({ name: 'tipo', required: false, enum: ['CUOTA_CARRO', 'CUOTA_CASA', 'OTRO'] })
  @ApiQuery({ name: 'periodo', required: false, example: '2026-10', description: 'Periodo para los KPIs; por defecto el mes actual (o el más reciente)' })
  @ApiOperation({
    summary: 'Resumen del carro: saldo a favor global, KPIs y periodos (más reciente primero) con sus aportes diarios y desglose',
  })
  resumen(@CurrentUser('userId') userId: bigint, @Query('tipo') tipo?: string, @Query('periodo') periodo?: string) {
    return this.aportes.resumenCarro(userId, { tipo, periodo });
  }

  @Get('carro/resumen-whatsapp')
  @ApiQuery({ name: 'periodo', required: false, example: '2026-10' })
  @ApiOperation({ summary: 'Último aporte y consolidado del mes listos para el WhatsApp a Papá (Fase 7)' })
  resumenWhatsApp(@CurrentUser('userId') userId: bigint, @Query('periodo') periodo?: string) {
    return this.aportes.resumenWhatsApp(userId, periodo);
  }

  @Post('periodos')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea o configura la cuota objetivo de un mes (si el mes ya existe, actualiza su cuota)' })
  guardarPeriodo(@Body() dto: GuardarPeriodoDto, @CurrentUser('userId') userId: bigint) {
    return this.aportes.guardarPeriodo(dto, userId);
  }

  @Post('periodos/:id/aplicar-excedente')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aplica el saldo a favor del periodo: lo traslada al mes siguiente o lo cruza contra el estado de cuenta del responsable' })
  aplicarExcedente(@Param('id', ParseIntPipe) id: number, @Body() dto: AplicarExcedenteDto, @CurrentUser('userId') userId: bigint) {
    return this.aportes.aplicarExcedente(id, dto, userId);
  }

  @Post('aportes-diarios')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Registra un aporte diario con N líneas (efectivo, transferencia, cruce de cuentas, saldo a favor). Un cruce a nombre de un tercero se le carga a su cuenta por cobrar',
  })
  crear(@Body() dto: CrearAporteDiarioDto, @CurrentUser('userId') userId: bigint) {
    return this.aportes.registrarAporteDiario(dto, userId);
  }

  @Put('aportes-diarios/:id')
  @ApiOperation({ summary: 'Reemplaza un aporte diario, revirtiendo y recreando atómicamente cruces, transacciones y saldo a favor' })
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarAporteDiarioDto, @CurrentUser('userId') userId: bigint) {
    return this.aportes.actualizarAporteDiario(id, dto, userId);
  }

  @Patch('aportes-diarios/:id')
  @ApiExcludeEndpoint()
  actualizarPatch(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarAporteDiarioDto, @CurrentUser('userId') userId: bigint) {
    return this.aportes.actualizarAporteDiario(id, dto, userId);
  }

  @Delete('aportes-diarios/:id')
  @ApiOperation({ summary: 'Elimina un aporte diario: anula el cruce y la transacción, devuelve el saldo a favor y borra el día' })
  eliminar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.aportes.eliminarAporteDiario(id, userId);
  }
}
