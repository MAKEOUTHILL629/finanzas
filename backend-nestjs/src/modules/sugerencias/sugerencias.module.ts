import { Module } from '@nestjs/common';
import { SugerenciasController } from './sugerencias.controller';
import { SugerenciasService } from './sugerencias.service';

@Module({
  controllers: [SugerenciasController],
  providers: [SugerenciasService],
  exports: [SugerenciasService],
})
export class SugerenciasModule {}
