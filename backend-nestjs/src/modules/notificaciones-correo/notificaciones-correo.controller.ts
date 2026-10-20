import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookOrJwtGuard } from '../../common/guards/webhook-or-jwt.guard';
import { ConciliarCorreoDto, IngestaCorreoDto, NotificacionesFiltroDto } from './dto/notificacion.dto';
import { AceptarSugerenciasDto, AsignarProductoDto, ReprocesarDto } from './dto/productos-correo.dto';
import { parseSyncBatchBody, SyncNotificacionesBatchDto } from './dto/sync-batch.dto';
import { AuditoriaCorreosService } from './auditoria-correos.service';
import { NotificacionesCorreoService } from './notificaciones-correo.service';
import { ProductosCorreoService } from './productos-correo.service';
import { ReprocesoCorreosService } from './reproceso-correos.service';
import { SyncBatchService } from './sync-batch.service';

@ApiTags('Notificaciones de correo')
@ApiBearerAuth()
@Controller('api/notificaciones-correo')
export class NotificacionesCorreoController {
  constructor(
    private readonly notificaciones: NotificacionesCorreoService,
    private readonly syncBatch: SyncBatchService,
    private readonly productos: ProductosCorreoService,
    private readonly reproceso: ReprocesoCorreosService,
    private readonly auditoria: AuditoriaCorreosService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Bandeja de conciliación (filtro por estado_procesamiento)' })
  list(@Query() filtro: NotificacionesFiltroDto, @CurrentUser('userId') userId: bigint) {
    return this.notificaciones.list(userId, filtro);
  }

  /**
   * Webhook del Google Apps Script. Autenticación: header `x-webhook-secret` (= WEBHOOK_SECRET; actúa como el usuario
   * DEFAULT_OWNER_USER_ID) o un JWT normal. Va marcado @Public para saltar el guard global; `WebhookOrJwtGuard`
   * hace la verificación real.
   */
  @Public()
  @UseGuards(WebhookOrJwtGuard)
  @Post('sync-batch')
  @HttpCode(200)
  @ApiHeader({ name: 'x-webhook-secret', required: false, description: 'Alternativa al JWT para el Apps Script' })
  @ApiBody({ type: SyncNotificacionesBatchDto })
  @ApiOperation({
    summary: 'Sincronización por lotes de correos de Bancolombia (idempotente por external_message_id)',
    description:
      'Cada ítem se procesa en su propia transacción. `syncedExternalIds` lista los ya persistidos (nuevos + ya existentes); ' +
      'los que fallaron por un error transitorio van en `errores` y NO en `syncedExternalIds`, para que el script los reintente.',
  })
  sync(@Body() body: unknown, @CurrentUser('userId') userId: bigint) {
    return this.syncBatch.syncBatch(parseSyncBatchBody(body), userId);
  }

  @Post('ingesta')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ingesta idempotente de UN correo (ON CONFLICT (external_message_id) DO NOTHING)',
    description:
      'Si datos_parseados.ultimos_4 identifica una única cuenta, crea la transacción PENDIENTE_REVISION (EMAIL_AUTO).',
  })
  ingesta(@Body() dto: IngestaCorreoDto, @CurrentUser('userId') userId: bigint) {
    return this.notificaciones.ingestar(dto, userId);
  }

  // ── Productos detectados por los últimos 4 dígitos (antes de `:id` para que no se confundan) ──

  @Get('productos')
  @ApiOperation({
    summary: 'Productos que aparecen en los correos (últimos 4 dígitos), a qué cuenta/tarjeta pertenecen y qué se sugiere',
    description: 'Las tarjetas se sugieren por evidencia (compras con la misma fecha y monto); las cuentas, por el rótulo «Cuenta *NNNN» del banco.',
  })
  listarProductos(@CurrentUser('userId') userId: bigint) {
    return this.productos.listar(userId);
  }

  @Post('productos/inferir')
  @HttpCode(200)
  @ApiOperation({ summary: 'Asocia solos a su tarjeta los últimos 4 dígitos con evidencia suficiente (≥3 compras coincidentes y ≥75 %)' })
  inferirProductos(@CurrentUser('userId') userId: bigint) {
    return this.productos.inferirTarjetas(userId, { aplicar: true });
  }

  @Post('productos/asignar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Asigna unos últimos 4 dígitos a una cuenta/tarjeta existente o crea el producto con ellos' })
  asignarProducto(@Body() dto: AsignarProductoDto, @CurrentUser('userId') userId: bigint) {
    return this.productos.asignar(dto, userId);
  }

  @Post('productos/aceptar-sugerencias')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acepta de una vez las sugerencias: asocia tarjetas por evidencia, crea las cuentas detectadas y agrega los débitos' })
  aceptarSugerencias(@Body() dto: AceptarSugerenciasDto, @CurrentUser('userId') userId: bigint) {
    return this.productos.aceptarSugerencias(userId, dto.ultimos4);
  }

  @Post('reprocesar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reprocesa los correos pendientes: enlaza lo que ya existe, evita duplicados y registra lo que falta',
    description:
      '`simular` (por defecto true) devuelve el resumen sin escribir nada. Con `simular=false` corre en segundo plano y devuelve `jobId`; ' +
      'se consulta con GET /reprocesar/:jobId. `desde` (yyyy-MM-dd) limita el REGISTRO de lo nuevo: antes de esa fecha solo se enlaza.',
  })
  reprocesar(@Body() dto: ReprocesarDto, @CurrentUser('userId') userId: bigint) {
    return this.reproceso.reprocesar(dto, userId);
  }

  @Post('auditar-falsos-positivos')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preview de falsos positivos históricos: compras que eran pagos de tarjeta o compras rechazadas (Fase 1)' })
  auditarFalsosPositivos(@CurrentUser('userId') userId: bigint) {
    return this.auditoria.auditar(userId);
  }

  @Post('revertir-falsos-positivos')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revierte los falsos positivos: elimina la compra errónea o la convierte en pago de tarjeta (Fase 1)' })
  revertirFalsosPositivos(@Body() body: { ids?: number[] }, @CurrentUser('userId') userId: bigint) {
    return this.auditoria.revertir(userId, body?.ids);
  }

  @Get('reprocesar/:jobId')
  @ApiOperation({ summary: 'Avance y resultado de un reproceso en segundo plano' })
  estadoReproceso(@Param('jobId') jobId: string, @CurrentUser('userId') userId: bigint) {
    return this.reproceso.estado(jobId, userId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.notificaciones.get(id, userId);
  }

  @Patch(':id/conciliar')
  @ApiOperation({
    summary: 'Concilia una notificación: cuotas, responsables, categoría, egreso→préstamo, o descartar',
  })
  conciliar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConciliarCorreoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.notificaciones.conciliar(id, dto, userId);
  }
}
