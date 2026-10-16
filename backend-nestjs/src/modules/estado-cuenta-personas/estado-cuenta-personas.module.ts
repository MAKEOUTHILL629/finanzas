import { Module } from '@nestjs/common';
import { LiquidacionMensualModule } from '../liquidacion-mensual/liquidacion-mensual.module';
import { EstadoCuentaPersonasController } from './estado-cuenta-personas.controller';
import { EstadoCuentaPersonasService } from './estado-cuenta-personas.service';

@Module({
  imports: [LiquidacionMensualModule],
  controllers: [EstadoCuentaPersonasController],
  providers: [EstadoCuentaPersonasService],
  exports: [EstadoCuentaPersonasService],
})
export class EstadoCuentaPersonasModule {}
