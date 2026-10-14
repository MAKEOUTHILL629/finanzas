import { Module } from '@nestjs/common';
import { TransaccionesModule } from '../transacciones/transacciones.module';
import { AportesCarroController } from './aportes-carro.controller';
import { AportesCarroService } from './aportes-carro.service';
import { ObligacionesAportesController } from './obligaciones-aportes.controller';
import { ObligacionesAportesService } from './obligaciones-aportes.service';

@Module({
  imports: [TransaccionesModule],
  controllers: [ObligacionesAportesController, AportesCarroController],
  providers: [ObligacionesAportesService, AportesCarroService],
  exports: [ObligacionesAportesService, AportesCarroService],
})
export class ObligacionesAportesModule {}
