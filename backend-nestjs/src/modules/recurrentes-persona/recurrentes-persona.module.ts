import { Module } from '@nestjs/common';
import { RecurrentesPersonaController } from './recurrentes-persona.controller';
import { RecurrentesPersonaService } from './recurrentes-persona.service';

@Module({
  controllers: [RecurrentesPersonaController],
  providers: [RecurrentesPersonaService],
  exports: [RecurrentesPersonaService],
})
export class RecurrentesPersonaModule {}
