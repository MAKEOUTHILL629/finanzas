import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CandidatasQueryDto, EjecutarBarridoFechaDto, EjecutarRefinanciamientoDto, SimularBarridoFechaDto, SimularRefinanciamientoDto } from './dto/refinanciamiento.dto';
import { RefinanciamientoService } from './refinanciamiento.service';

/** Unificación de deuda de una tarjeta de crédito: simular con lo que dice el banco, ejecutar de forma atómica y deshacer. */
@ApiTags('Refinanciamientos')
@ApiBearerAuth()
@Controller('api/refinanciamientos')
export class RefinanciamientosController {
  constructor(private readonly refinanciamientos: RefinanciamientoService) {}

  @Get('candidatas')
  @ApiOperation({ summary: 'Compras pendientes de una tarjeta que se pueden unificar, con su saldo de capital y sus responsables' })
  candidatas(@Query() query: CandidatasQueryDto, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.candidatas(userId, query.tarjetaId);
  }

  @Post('simular')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simula la unificación (cuota, costo total, comparación con lo que pagas hoy) sin escribir nada' })
  simular(@Body() dto: SimularRefinanciamientoDto, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.simular(userId, dto);
  }

  @Post('simular-barrido-fecha')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simula el barrido automático por fecha de corte (detecta compras vigentes y compara capital teórico vs. valor del banco)' })
  simularBarridoFecha(@Body() dto: SimularBarridoFechaDto, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.simularBarridoFecha(userId, dto);
  }

  @Post('ejecutar-barrido-fecha')
  @ApiOperation({ summary: 'Ejecuta el barrido por fecha de corte en una sola transacción (maestra por el valor del banco $X)' })
  ejecutarBarridoFecha(@Body() dto: EjecutarBarridoFechaDto, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.ejecutarBarridoFecha(userId, dto);
  }

  @Post()
  @ApiOperation({
    summary: 'Ejecuta la unificación en una sola transacción',
    description:
      'Crea la obligación nueva (N cuotas, cuota fija) con las personas responsables de las originales, marca las originales como REFINANCIADA ' +
      '(vinculadas a la nueva) y anula los cargos futuros que tenían en el sub-ledger de las personas.',
  })
  ejecutar(@Body() dto: EjecutarRefinanciamientoDto, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.ejecutar(userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un refinanciamiento: `id` puede ser la compra nueva o cualquiera de las unificadas' })
  detalle(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.detalle(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deshace un refinanciamiento (mientras la obligación nueva no tenga cuotas pagadas)' })
  deshacer(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.refinanciamientos.deshacer(userId, id);
  }
}
