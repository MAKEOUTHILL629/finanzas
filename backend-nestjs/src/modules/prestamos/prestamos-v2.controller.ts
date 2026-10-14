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
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CortesCobroService } from './cortes-cobro.service';
import {
  CreateCorteCobroDto,
  ResolverAprobacionDto,
  ResolverAprobacionPorPersonaDto,
  UpdateCorteCobroDto,
  UpdatePrestamoDto,
} from './dto/prestamo.dto';
import { PrestamosService } from './prestamos.service';

@ApiTags('Préstamos v2')
@ApiBearerAuth()
@Controller('api/prestamos')
export class PrestamosV2Controller {
  constructor(private readonly prestamos: PrestamosService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.prestamos.get(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Actualiza estado/saldo/método/corte. Pasar a 'Pagado' dispara el abono vía Trigger 4" })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePrestamoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.prestamos.update(id, dto, userId);
  }

  @Get(':id/aprobaciones')
  aprobaciones(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.prestamos.listAprobaciones(id, userId);
  }

  /** Plan: `PATCH /prestamos/:id/aprobaciones` — la persona (o el administrador) aprueba/rechaza su aprobación. */
  @Patch(':id/aprobaciones')
  @ApiOperation({ summary: 'Aprueba o rechaza la aprobación pendiente de una persona sobre el préstamo' })
  resolverPorPersona(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolverAprobacionPorPersonaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prestamos.resolverAprobacionPorPersona(id, dto, user);
  }

  @Patch(':id/aprobaciones/:aprobacionId')
  @ApiOperation({ summary: 'Aprobar o rechazar (con comentarios y fecha) una aprobación de préstamo' })
  resolverAprobacion(
    @Param('id', ParseIntPipe) id: number,
    @Param('aprobacionId', ParseIntPipe) aprobacionId: number,
    @Body() dto: ResolverAprobacionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prestamos.resolverAprobacion(id, aprobacionId, dto, user);
  }
}

@ApiTags('Cortes de cobro')
@ApiBearerAuth()
@Controller('api/cortes-cobro')
export class CortesCobroController {
  constructor(private readonly cortes: CortesCobroService) {}

  @Get()
  @ApiQuery({ name: 'estado', required: false, enum: ['PASADO', 'ACTIVO', 'FUTURO'] })
  list(@Query('estado') estado: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.cortes.list(userId, estado);
  }

  /** Debe declararse antes de `:id`. */
  @Get('activo')
  @ApiOperation({ summary: 'Corte vigente según la fecha de hoy' })
  activo(@CurrentUser('userId') userId: bigint) {
    return this.cortes.activo(userId);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateCorteCobroDto, @CurrentUser('userId') userId: bigint) {
    return this.cortes.create(dto, userId);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCorteCobroDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cortes.update(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCorteCobroDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cortes.update(id, dto, userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint): Promise<void> {
    await this.cortes.remove(id, userId);
  }
}
