import { Module } from '@nestjs/common';
import { CategoriasController, CuentasFinancierasController } from './cuentas-financieras.controller';
import { CuentasFinancierasService } from './cuentas-financieras.service';

@Module({
  controllers: [CuentasFinancierasController, CategoriasController],
  providers: [CuentasFinancierasService],
  exports: [CuentasFinancierasService],
})
export class CuentasFinancierasModule {}
