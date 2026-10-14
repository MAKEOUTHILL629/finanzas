import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookOrJwtGuard } from '../../common/guards/webhook-or-jwt.guard';
import { ConciliarCorreoDto, IngestaCorreoDto, NotificacionesFiltroDto } from './dto/notificacion.dto';
import { parseSyncBatchBody, SyncNotificacionesBatchDto } from './dto/sync-batch.dto';
import { NotificacionesCorreoService } from './notificaciones-correo.service';
import { SyncBatchService } from './sync-batch.service';

@ApiTags('Notificaciones de correo')
@ApiBearerAuth()
@Controller('api/notificaciones-correo')
export class NotificacionesCorreoController {
  constructor(
    private readonly notificaciones: NotificacionesCorreoService,
    private readonly syncBatch: SyncBatchService,
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
