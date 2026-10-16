import { Module } from '@nestjs/common';
import { LiquidacionMensualModule } from '../liquidacion-mensual/liquidacion-mensual.module';
import { CobroPublicoController } from './cobro-publico.controller';
import { CobroPublicoService } from './cobro-publico.service';
import { CobrosController, CobrosPuntualesController } from './cobros.controller';
import { CobrosPuntualesService } from './cobros-puntuales.service';
import { EnlacesCobroService } from './enlaces-cobro.service';
import { ReportesPagoService } from './reportes-pago.service';

@Module({
  imports: [LiquidacionMensualModule],
  controllers: [CobrosPuntualesController, CobrosController, CobroPublicoController],
  providers: [CobrosPuntualesService, EnlacesCobroService, ReportesPagoService, CobroPublicoService],
  exports: [CobrosPuntualesService, EnlacesCobroService, ReportesPagoService],
})
export class CobrosModule {}
