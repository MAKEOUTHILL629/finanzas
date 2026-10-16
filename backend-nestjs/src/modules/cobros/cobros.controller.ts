import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CobrosPuntualesService } from './cobros-puntuales.service';
import {
  AplicarIngresoDto,
  AprobarReporteDto,
  FiltroCobrosDto,
  FiltroEnlacesDto,
  FiltroReportesDto,
  GenerarEnlaceDto,
  GuardarCobroPuntualDto,
  RechazarReporteDto,
} from './dto/cobros.dto';
import { EnlacesCobroService } from './enlaces-cobro.service';
import { ReportesPagoService } from './reportes-pago.service';

/** Gastos repartidos entre varias personas (la luz, el mercado, una fiesta…): cada parte se cobra en la liquidación del mes. */
@ApiTags('Cobros puntuales')
@ApiBearerAuth()
@Controller('api/cobros-puntuales')
export class CobrosPuntualesController {
  constructor(private readonly cobros: CobrosPuntualesService) {}

  @Get()
  @ApiOperation({ summary: 'Cobros repartidos (por mes y estado)' })
  listar(@Query() filtro: FiltroCobrosDto, @CurrentUser('userId') userId: bigint) {
    return this.cobros.listar(userId, filtro);
  }

  @Get(':id')
  obtener(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.cobros.obtener(id, userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Reparte un gasto entre personas: cada una recibe su cargo en la liquidación del mes' })
  crear(@Body() dto: GuardarCobroPuntualDto, @CurrentUser('userId') userId: bigint) {
    return this.cobros.crear(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Rehace el reparto (los pagos ya registrados no se tocan)' })
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: GuardarCobroPuntualDto, @CurrentUser('userId') userId: bigint) {
    return this.cobros.actualizar(id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Anula el cobro: sus cargos dejan de contar en la liquidación' })
  anular(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.cobros.anular(id, userId);
  }
}

/** Enlaces para compartir la liquidación con cada persona, y revisión de los pagos que ellas reportan. */
@ApiTags('Cobros a personas')
@ApiBearerAuth()
@Controller('api/cobros')
export class CobrosController {
  constructor(
    private readonly enlaces: EnlacesCobroService,
    private readonly reportes: ReportesPagoService,
  ) {}

  // ── enlaces ──

  @Post('enlaces')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Genera (o actualiza) el enlace de una persona para un mes',
    description: 'Guarda una foto de su liquidación. Si ya existía, la actualiza y conserva el enlace (salvo `rotarToken`).',
  })
  generar(@Body() dto: GenerarEnlaceDto, @CurrentUser('userId') userId: bigint) {
    return this.enlaces.generar(dto, userId);
  }

  @Get('enlaces')
  @ApiOperation({ summary: 'Enlaces generados (con visitas y pagos pendientes de revisar)' })
  listarEnlaces(@Query() filtro: FiltroEnlacesDto, @CurrentUser('userId') userId: bigint) {
    return this.enlaces.listar(userId, filtro);
  }

  @Post('enlaces/:id/refrescar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Vuelve a tomar la foto de la liquidación (conserva el mismo enlace)' })
  refrescar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.enlaces.refrescar(id, userId);
  }

  @Post('enlaces/:id/revocar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deja de funcionar el enlace (se puede reactivar generándolo otra vez)' })
  revocar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.enlaces.revocar(id, userId);
  }

  // ── pagos reportados ──

  @Get('reportes')
  @ApiOperation({ summary: 'Pagos que las personas reportaron desde su enlace (con aviso si el dinero ya llegó por correo)' })
  listarReportes(@Query() filtro: FiltroReportesDto, @CurrentUser('userId') userId: bigint) {
    return this.reportes.listar(userId, filtro);
  }

  @Get('reportes/:id/comprobante')
  @ApiOperation({ summary: 'Descarga el comprobante adjunto (solo el propietario)' })
  async comprobante(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint, @Res({ passthrough: true }) res: Response) {
    const c = await this.reportes.comprobante(id, userId);
    res.set({
      'Content-Type': c.tipo,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(c.nombre)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(c.datos);
  }

  @Post('reportes/:id/aprobar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aprueba un pago reportado: registra el abono (y el ingreso en tu cuenta, o enlaza uno que ya existe)',
    description: 'Con `transaccionId` se enlaza un ingreso existente; con `cuentaDestinoId` se crea el ingreso; sin ninguno solo se anota el abono.',
  })
  aprobar(@Param('id', ParseIntPipe) id: number, @Body() dto: AprobarReporteDto, @CurrentUser('userId') userId: bigint) {
    return this.reportes.aprobar(id, dto, userId);
  }

  @Post('reportes/:id/rechazar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechaza un pago reportado (la persona ve el motivo y su deuda sigue igual)' })
  rechazar(@Param('id', ParseIntPipe) id: number, @Body() dto: RechazarReporteDto, @CurrentUser('userId') userId: bigint) {
    return this.reportes.rechazar(id, dto, userId);
  }

  // ── ingresos ya recibidos ──

  @Get('ingresos-sugeridos')
  @ApiOperation({ summary: 'Ingresos detectados por correo que vienen de una persona registrada y aún no se aplicaron a su deuda' })
  ingresosSugeridos(@Query() filtro: FiltroEnlacesDto, @CurrentUser('userId') userId: bigint) {
    return this.reportes.ingresosSugeridos(userId, filtro.periodo);
  }

  @Post('pagos/aplicar-ingreso')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aplica un ingreso que ya está en tus cuentas como pago de una persona (sin crear otra transacción)' })
  aplicarIngreso(@Body() dto: AplicarIngresoDto, @CurrentUser('userId') userId: bigint) {
    return this.reportes.aplicarIngreso(dto, userId);
  }
}
