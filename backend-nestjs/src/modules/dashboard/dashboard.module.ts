import { Module } from '@nestjs/common';
import { EstadoCuentaPersonasModule } from '../estado-cuenta-personas/estado-cuenta-personas.module';
import { LookupModule } from '../lookup/lookup.module';
import { SubledgerDeudasModule } from '../subledger-deudas/subledger-deudas.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [LookupModule, SubledgerDeudasModule, EstadoCuentaPersonasModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
