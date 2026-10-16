import { Module } from '@nestjs/common';
import { ProductosFinancierosController } from './productos-financieros.controller';
import { ProductosFinancierosService } from './productos-financieros.service';

@Module({
  controllers: [ProductosFinancierosController],
  providers: [ProductosFinancierosService],
  exports: [ProductosFinancierosService],
})
export class ProductosFinancierosModule {}
