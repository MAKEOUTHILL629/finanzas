import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ActualizarRecurrentePersonaDto,
  CrearRecurrentePersonaDto,
  FiltroRecurrentesPersonaDto,
} from './dto/recurrente-persona.dto';
import { RecurrentesPersonaService } from './recurrentes-persona.service';

/** Cargos y abonos mensuales recurrentes por persona (vitalicios o por X meses). También en `/api/v2/recurrentes-persona`. */
@ApiTags('Recurrentes por persona')
@ApiBearerAuth()
@Controller('api/recurrentes-persona')
export class RecurrentesPersonaController {
  constructor(private readonly recurrentes: RecurrentesPersonaService) {}

  @Get()
  @ApiOperation({ summary: 'Lista los recurrentes por persona, con su progreso (cuota k de X) o el distintivo de vitalicio' })
  list(@Query() filtro: FiltroRecurrentesPersonaDto, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.list(userId, filtro);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un cargo (o valor a favor) mensual para una persona: de por vida (INDEFINIDO) o por X meses (PLAZO_FIJO)' })
  create(@Body() dto: CrearRecurrentePersonaDto, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.create(dto, userId);
  }

  @Post('generar-mes/:periodo')
  @HttpCode(200)
  @ApiOperation({ summary: 'Genera (idempotente) los cargos recurrentes del mes YYYY-MM en el estado de cuenta de cada persona' })
  generarMes(@Param('periodo') periodo: string, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.generarMes(periodo, userId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.get(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita el monto, la duración o el estado (pausar/activar) de un recurrente' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarRecurrentePersonaDto, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.update(id, dto, userId);
  }

  @Put(':id')
  @ApiExcludeEndpoint()
  replace(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarRecurrentePersonaDto, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.update(id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Elimina el recurrente y anula sus asientos del estado de cuenta' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.remove(id, userId);
  }
}
