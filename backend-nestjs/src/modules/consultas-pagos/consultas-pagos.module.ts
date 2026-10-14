import { Module } from '@nestjs/common';
import { ConsultasPagosController } from './consultas-pagos.controller';
import { ConsultasPagosService } from './consultas-pagos.service';

@Module({
  controllers: [ConsultasPagosController],
  providers: [ConsultasPagosService],
})
export class ConsultasPagosModule {}
