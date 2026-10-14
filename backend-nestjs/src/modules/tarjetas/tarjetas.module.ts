import { Module } from '@nestjs/common';
import { TarjetasV2Controller } from './tarjetas-v2.controller';
import { TarjetasController } from './tarjetas.controller';
import { TarjetasService } from './tarjetas.service';
import { WebScrapingService } from './web-scraping.service';

@Module({
  controllers: [TarjetasController, TarjetasV2Controller],
  providers: [TarjetasService, WebScrapingService],
  exports: [TarjetasService, WebScrapingService],
})
export class TarjetasModule {}
