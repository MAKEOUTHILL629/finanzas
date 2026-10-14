import { Module } from '@nestjs/common';
import { SubledgerDeudasController } from './subledger-deudas.controller';
import { SubledgerDeudasService } from './subledger-deudas.service';

@Module({
  controllers: [SubledgerDeudasController],
  providers: [SubledgerDeudasService],
})
export class SubledgerDeudasModule {}
