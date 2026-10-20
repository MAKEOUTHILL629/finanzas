import { Module } from '@nestjs/common';
import { TransaccionesModule } from '../transacciones/transacciones.module';
import { CortesCobroService } from './cortes-cobro.service';
import { PrestamosV2Controller, CortesCobroController } from './prestamos-v2.controller';
import { PrestamosController } from './prestamos.controller';
import { PrestamosPasivosService } from './prestamos-pasivos.service';
import { PrestamosService } from './prestamos.service';

@Module({
  imports: [TransaccionesModule],
  controllers: [PrestamosController, PrestamosV2Controller, CortesCobroController],
  providers: [PrestamosService, CortesCobroService, PrestamosPasivosService],
  exports: [PrestamosService, CortesCobroService, PrestamosPasivosService],
})
export class PrestamosModule {}
