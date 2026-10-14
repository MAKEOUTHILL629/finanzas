import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateObligacionMesDto, RegistrarAportesDiaDto } from './dto/obligacion.dto';
import { ObligacionesAportesService } from './obligaciones-aportes.service';

@ApiTags('Obligaciones y aportes')
@ApiBearerAuth()
@Controller('api/obligaciones-mes')
export class ObligacionesAportesController {
  constructor(private readonly obligaciones: ObligacionesAportesService) {}

  @Get()
  @ApiQuery({ name: 'periodo', required: false, example: '2026-09' })
  @ApiQuery({ name: 'tipo', required: false, enum: ['CUOTA_CARRO', 'CUOTA_CASA', 'OTRO'] })
  @ApiOperation({ summary: 'Resumen de obligaciones (vista vw_ResumenObligacionesMes)' })
  list(
    @CurrentUser('userId') userId: bigint,
    @Query('periodo') periodo?: string,
    @Query('tipo') tipo?: string,
  ) {
    return this.obligaciones.listResumen(userId, periodo, tipo);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateObligacionMesDto, @CurrentUser('userId') userId: bigint) {
    return this.obligaciones.create(dto, userId);
  }

  @Get(':id/resumen')
  @ApiOperation({ summary: 'meta_mensual, aporte_total_real, restante_real, directo vs. por cruces y estado_calculado' })
  resumen(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.obligaciones.resumen(id, userId);
  }

  @Get(':id/dias')
  @ApiOperation({ summary: 'Días de aporte (vw_AportesDiaResumen) con el desglose de AportesDetalle y Personas' })
  dias(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.obligaciones.aportesDia(id, userId);
  }

  /** Alias de compatibilidad (nombre usado en la primera versión del plan). */
  @Get(':id/aportes-dia')
  @ApiExcludeEndpoint()
  aportesDia(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.obligaciones.aportesDia(id, userId);
  }

  @Post(':id/aportes-dia')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Registra los aportes de un día. El aporte de un tercero crea el préstamo por cruce vía Trigger 3',
  })
  registrar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegistrarAportesDiaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.obligaciones.registrarAportesDia(id, dto, userId);
  }
}
