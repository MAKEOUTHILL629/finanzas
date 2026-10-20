import { Module } from '@nestjs/common';
import { LiquidacionMensualModule } from '../liquidacion-mensual/liquidacion-mensual.module';
import { CobroPublicoController, PortalAcreedorController } from './cobro-publico.controller';
import { CobroPublicoService } from './cobro-publico.service';
import { CobrosController, CobrosPuntualesController, MetodosPagoController } from './cobros.controller';
import { CobrosPuntualesService } from './cobros-puntuales.service';
import { EnlacesCobroService } from './enlaces-cobro.service';
import { MetodosPagoService } from './metodos-pago.service';
import { ObjecionesCobroService } from './objeciones-cobro.service';
import { ReportesPagoService } from './reportes-pago.service';

@Module({
  imports: [LiquidacionMensualModule],
  controllers: [CobrosPuntualesController, CobrosController, MetodosPagoController, CobroPublicoController, PortalAcreedorController],
  providers: [CobrosPuntualesService, EnlacesCobroService, ReportesPagoService, MetodosPagoService, ObjecionesCobroService, CobroPublicoService],
  exports: [CobrosPuntualesService, EnlacesCobroService, ReportesPagoService, MetodosPagoService, ObjecionesCobroService],
})
export class CobrosModule {}
