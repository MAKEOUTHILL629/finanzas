import { Module } from '@nestjs/common';
import { TransaccionesController } from './transacciones.controller';
import { TransaccionesService } from './transacciones.service';

@Module({
  controllers: [TransaccionesController],
  providers: [TransaccionesService],
  exports: [TransaccionesService],
})
export class TransaccionesModule {}
