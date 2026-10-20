import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import {
  CreatePlantillaRecurrenteDto,
  ProyectarPeriodoDto,
  RegistrarPagoPeriodoDto,
  UpdatePlantillaRecurrenteDto,
} from './dto/recurrente.dto';
import { GastosRecurrentesService } from './gastos-recurrentes.service';

@ApiTags('Gastos recurrentes')
@ApiBearerAuth()
@Controller('api/recurrentes/plantillas')
export class PlantillasRecurrentesController {
  constructor(private readonly recurrentes: GastosRecurrentesService) {}

  @Get()
  @ApiQuery({ name: 'soloActivas', required: false, type: Boolean })
  list(@CurrentUser('userId') userId: bigint, @Query('soloActivas') soloActivas?: string) {
    return this.recurrentes.listPlantillas(userId, soloActivas === 'true');
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.getPlantilla(id, userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea una plantilla recurrente con su reparto entre participantes' })
  create(@Body() dto: CreatePlantillaRecurrenteDto, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.createPlantilla(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edita la plantilla; si se envía `responsables` se reemplaza todo el reparto' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePlantillaRecurrenteDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.recurrentes.updatePlantilla(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePlantillaRecurrenteDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.recurrentes.updatePlantilla(id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Elimina la plantilla (o la desactiva si ya tiene periodos generados)' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.removePlantilla(id, userId);
  }
}

@ApiTags('Gastos recurrentes')
@ApiBearerAuth()
@Controller('api/recurrentes/periodos')
export class PeriodosRecurrentesController {
  constructor(private readonly recurrentes: GastosRecurrentesService) {}

  @Get()
  @ApiQuery({ name: 'periodo', required: false, example: '2026-11' })
  @ApiQuery({ name: 'estado', required: false })
  list(
    @CurrentUser('userId') userId: bigint,
    @Query('periodo') periodo?: string,
    @Query('estado') estado?: string,
  ) {
    return this.recurrentes.listPeriodos(userId, periodo, estado);
  }

  @Patch(':id/pagar')
  @ApiOperation({
    summary: 'Registra el pago real; PAGADO/FACTURADO dispara el Trigger 7 (cargo proporcional a cada participante)',
  })
  registrarPago(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegistrarPagoPeriodoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.recurrentes.registrarPago(id, dto, userId);
  }
}

@ApiTags('Gastos recurrentes')
@ApiBearerAuth()
@Controller('api/recurrentes/radar')
export class RadarSuscripcionesController {
  constructor(private readonly recurrentes: GastosRecurrentesService) {}

  @Get()
  @ApiOperation({ summary: 'Radar de suscripciones: pagos recurrentes detectados por correlación (Fase 3)' })
  @ApiQuery({ name: 'meses', required: false, type: Number })
  detectar(@CurrentUser('userId') userId: bigint, @Query('meses') meses?: string) {
    const n = meses ? Number(meses) : 6;
    return this.recurrentes.detectarPagosRecurrentesPorCorrelacion(userId, Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 6);
  }

  @Post('marcar-cancelar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marca una suscripción detectada como pendiente de cancelación' })
  marcarCancelar(@Body() dto: { comercio: string; monto?: number | string; frecuencia?: string }, @CurrentUser('userId') userId: bigint) {
    return this.recurrentes.marcarParaCancelar(userId, dto);
  }
}

@ApiTags('Gastos recurrentes')
@ApiBearerAuth()
@Controller('api/recurrentes')
export class ProyeccionRecurrentesController {
  constructor(private readonly recurrentes: GastosRecurrentesService) {}

  /** Body `{ periodo: 'YYYY-MM' }` (también acepta `?periodo=`). Idempotente. */
  @Post('proyectar-mes')
  @HttpCode(200)
  @ApiBody({ type: ProyectarPeriodoDto })
  @ApiOperation({
    summary: 'Proyecta el mes: promedio móvil de 3 pagos reales (variables) o monto base (fijos). Idempotente.',
  })
  proyectarMes(
    @Body() body: Partial<ProyectarPeriodoDto> | undefined,
    @Query('periodo') periodoQuery: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    const periodo = body?.periodo ?? periodoQuery;
    if (!periodo) throw datosInvalidos({ periodo: ['periodo es obligatorio (YYYY-MM)'] });
    return this.recurrentes.proyectar(periodo, userId);
  }
}
