import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EventosGrupalesService } from './eventos-grupales.service';
import { GastoEvento } from './eventos-grupales.calc';

@ApiTags('Eventos grupales')
@ApiBearerAuth()
@Controller('api/eventos-grupales')
export class EventosGrupalesController {
  constructor(private readonly eventos: EventosGrupalesService) {}

  @Get()
  @ApiOperation({ summary: 'Eventos/viajes grupales del usuario (Fase 4)' })
  listar(@CurrentUser('userId') userId: bigint) {
    return this.eventos.listar(userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un evento grupal con sus participantes (alias de bloque y peso/cupos)' })
  crear(@Body() dto: { nombre: string; fechaInicio?: string; fechaFin?: string; participantes: Array<{ personaId: number; aliasBloque?: string; peso?: number | string }> }, @CurrentUser('userId') userId: bigint) {
    return this.eventos.crear(userId, dto);
  }

  @Post(':id/gastos')
  @HttpCode(201)
  @ApiOperation({ summary: 'Agrega un gasto al evento (quién pagó y cómo se divide)' })
  gasto(@Param('id', ParseIntPipe) id: number, @Body() dto: { descripcion: string; montoTotal: number | string; pagadoPorParticipanteId: number; tipoDivision?: GastoEvento['tipoDivision']; divisionJson?: Record<string, number | string>; fecha?: string }, @CurrentUser('userId') userId: bigint) {
    return this.eventos.agregarGasto(userId, id, dto);
  }

  @Get(':id/liquidacion')
  @ApiOperation({ summary: 'Liquidación: cuánto puso cada uno, cuánto le toca («Nos toca $X») y el cruce mínimo de cuentas' })
  liquidacion(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.eventos.liquidar(userId, id);
  }

  @Post(':id/cerrar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cierra el evento y devuelve su liquidación final' })
  cerrar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.eventos.cerrar(userId, id);
  }
}
