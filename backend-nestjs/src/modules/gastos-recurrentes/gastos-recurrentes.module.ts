import { Module } from '@nestjs/common';
import { TransaccionesModule } from '../transacciones/transacciones.module';
import {
  PeriodosRecurrentesController,
  PlantillasRecurrentesController,
  ProyeccionRecurrentesController,
  RadarSuscripcionesController,
} from './gastos-recurrentes.controller';
import { GastosRecurrentesService } from './gastos-recurrentes.service';

@Module({
  imports: [TransaccionesModule],
  controllers: [PlantillasRecurrentesController, PeriodosRecurrentesController, ProyeccionRecurrentesController, RadarSuscripcionesController],
  providers: [GastosRecurrentesService],
  exports: [GastosRecurrentesService],
})
export class GastosRecurrentesModule {}
