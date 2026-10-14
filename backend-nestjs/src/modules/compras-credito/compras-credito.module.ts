import { Module } from '@nestjs/common';
import { ComprasCreditoCsvService } from './compras-credito-csv.service';
import { ComprasCreditoV2Controller } from './compras-credito-v2.controller';
import { ComprasCreditoController } from './compras-credito.controller';
import { ComprasCreditoService } from './compras-credito.service';
import { CuotasDetalleController } from './cuotas-detalle.controller';
import { CuotasDetalleService } from './cuotas-detalle.service';
import { PagosTarjetaController } from './pagos-tarjeta.controller';
import { PagosService } from './pagos.service';
import { ResponsablesController } from './responsables.controller';
import { ResponsablesService } from './responsables.service';

@Module({
  // El orden importa: las rutas estáticas primero; `GET api/compras-credito/:id` (cuotas) al final.
  controllers: [
    ResponsablesController, // rutas estáticas (/responsables) antes que `PUT/DELETE :id`
    ComprasCreditoController,
    PagosTarjetaController,
    ComprasCreditoV2Controller,
    CuotasDetalleController,
  ],
  providers: [ComprasCreditoService, ComprasCreditoCsvService, CuotasDetalleService, PagosService, ResponsablesService],
  exports: [ComprasCreditoService, PagosService, ResponsablesService],
})
export class ComprasCreditoModule {}
