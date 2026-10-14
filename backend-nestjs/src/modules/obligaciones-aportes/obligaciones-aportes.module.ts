import { Module } from '@nestjs/common';
import { ObligacionesAportesController } from './obligaciones-aportes.controller';
import { ObligacionesAportesService } from './obligaciones-aportes.service';

@Module({
  controllers: [ObligacionesAportesController],
  providers: [ObligacionesAportesService],
})
export class ObligacionesAportesModule {}
