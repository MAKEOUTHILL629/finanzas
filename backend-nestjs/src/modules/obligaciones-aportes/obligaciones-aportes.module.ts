import { Module } from '@nestjs/common';
import { TransaccionesModule } from '../transacciones/transacciones.module';
import { AportesCarroController, AportesCarroTransferenciasController } from './aportes-carro.controller';
import { AportesCarroService } from './aportes-carro.service';
import { ObligacionesAportesController } from './obligaciones-aportes.controller';
import { ObligacionesAportesService } from './obligaciones-aportes.service';

@Module({
  imports: [TransaccionesModule],
  controllers: [ObligacionesAportesController, AportesCarroController, AportesCarroTransferenciasController],
  providers: [ObligacionesAportesService, AportesCarroService],
  exports: [ObligacionesAportesService, AportesCarroService],
})
export class ObligacionesAportesModule {}
