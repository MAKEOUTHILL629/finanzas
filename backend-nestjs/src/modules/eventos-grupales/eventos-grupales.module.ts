import { Module } from '@nestjs/common';
import { EventosGrupalesController } from './eventos-grupales.controller';
import { EventosGrupalesService } from './eventos-grupales.service';

@Module({
  controllers: [EventosGrupalesController],
  providers: [EventosGrupalesService],
  exports: [EventosGrupalesService],
})
export class EventosGrupalesModule {}
