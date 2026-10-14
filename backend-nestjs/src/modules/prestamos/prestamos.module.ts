import { Module } from '@nestjs/common';
import { CortesCobroService } from './cortes-cobro.service';
import { PrestamosV2Controller, CortesCobroController } from './prestamos-v2.controller';
import { PrestamosController } from './prestamos.controller';
import { PrestamosService } from './prestamos.service';

@Module({
  controllers: [PrestamosController, PrestamosV2Controller, CortesCobroController],
  providers: [PrestamosService, CortesCobroService],
  exports: [PrestamosService, CortesCobroService],
})
export class PrestamosModule {}
