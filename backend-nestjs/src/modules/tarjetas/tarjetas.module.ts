import { Module } from '@nestjs/common';
import { PlasticosController } from './plasticos.controller';
import { PlasticosTarjetaService } from './plasticos-tarjeta.service';
import { TarjetasV2Controller } from './tarjetas-v2.controller';
import { TarjetasController } from './tarjetas.controller';
import { TarjetasService } from './tarjetas.service';
import { WebScrapingService } from './web-scraping.service';

@Module({
  controllers: [TarjetasController, TarjetasV2Controller, PlasticosController],
  providers: [TarjetasService, WebScrapingService, PlasticosTarjetaService],
  exports: [TarjetasService, WebScrapingService, PlasticosTarjetaService],
})
export class TarjetasModule {}
