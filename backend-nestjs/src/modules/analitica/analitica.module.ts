import { Module } from '@nestjs/common';
import { AnaliticaController } from './analitica.controller';
import { AnaliticaService } from './analitica.service';
import { TaggingEngineService } from './tagging-engine.service';

@Module({
  controllers: [AnaliticaController],
  providers: [AnaliticaService, TaggingEngineService],
  exports: [TaggingEngineService, AnaliticaService],
})
export class AnaliticaModule {}
