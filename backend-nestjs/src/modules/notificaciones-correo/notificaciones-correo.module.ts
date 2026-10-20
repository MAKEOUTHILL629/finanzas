import { Module } from '@nestjs/common';
import { WebhookOrJwtGuard } from '../../common/guards/webhook-or-jwt.guard';
import { ComprasCreditoModule } from '../compras-credito/compras-credito.module';
import { PrestamosModule } from '../prestamos/prestamos.module';
import { TransaccionesModule } from '../transacciones/transacciones.module';
import { AuditoriaCorreosService } from './auditoria-correos.service';
import { NotificacionesCorreoController } from './notificaciones-correo.controller';
import { NotificacionesCorreoService } from './notificaciones-correo.service';
import { EjecutorCorreosService } from './ejecutor-correos.service';
import { ProductosCorreoService } from './productos-correo.service';
import { ReprocesoCorreosService } from './reproceso-correos.service';
import { SyncBatchService } from './sync-batch.service';

@Module({
  imports: [TransaccionesModule, ComprasCreditoModule, PrestamosModule],
  controllers: [NotificacionesCorreoController],
  providers: [
    NotificacionesCorreoService,
    SyncBatchService,
    EjecutorCorreosService,
    ProductosCorreoService,
    ReprocesoCorreosService,
    AuditoriaCorreosService,
    WebhookOrJwtGuard,
  ],
})
export class NotificacionesCorreoModule {}
