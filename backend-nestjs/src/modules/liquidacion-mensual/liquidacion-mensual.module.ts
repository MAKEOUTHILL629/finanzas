import { Module } from '@nestjs/common';
import { RecurrentesPersonaModule } from '../recurrentes-persona/recurrentes-persona.module';
import { SubledgerDeudasModule } from '../subledger-deudas/subledger-deudas.module';
import { LiquidacionMensualController } from './liquidacion-mensual.controller';
import { CuotasTercerosService } from './cuotas-terceros.service';
import { LiquidacionMensualService } from './liquidacion-mensual.service';

@Module({
  imports: [RecurrentesPersonaModule, SubledgerDeudasModule],
  controllers: [LiquidacionMensualController],
  providers: [LiquidacionMensualService, CuotasTercerosService],
  exports: [LiquidacionMensualService, CuotasTercerosService],
})
export class LiquidacionMensualModule {}
