import { Module, ValidationError, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { JsonSerializationInterceptor } from './common/interceptors/json-serialization.interceptor';
import { datosInvalidos } from './common/utils/legacy-http.util';
import { validateEnv } from './config/env.validation';
import { AnaliticaModule } from './modules/analitica/analitica.module';
import { AuthModule } from './modules/auth/auth.module';
import { CobrosModule } from './modules/cobros/cobros.module';
import { ComprasCreditoModule } from './modules/compras-credito/compras-credito.module';
import { ConsultasPagosModule } from './modules/consultas-pagos/consultas-pagos.module';
import { CuentasFinancierasModule } from './modules/cuentas-financieras/cuentas-financieras.module';
import { GastosRecurrentesModule } from './modules/gastos-recurrentes/gastos-recurrentes.module';
import { NotificacionesCorreoModule } from './modules/notificaciones-correo/notificaciones-correo.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { EventosGrupalesModule } from './modules/eventos-grupales/eventos-grupales.module';
import { EstadoCuentaPersonasModule } from './modules/estado-cuenta-personas/estado-cuenta-personas.module';
import { LiquidacionMensualModule } from './modules/liquidacion-mensual/liquidacion-mensual.module';
import { ObligacionesAportesModule } from './modules/obligaciones-aportes/obligaciones-aportes.module';
import { RecurrentesPersonaModule } from './modules/recurrentes-persona/recurrentes-persona.module';
import { SubledgerDeudasModule } from './modules/subledger-deudas/subledger-deudas.module';
import { TransaccionesModule } from './modules/transacciones/transacciones.module';
import { HomeModule } from './modules/home/home.module';
import { LookupModule } from './modules/lookup/lookup.module';
import { PersonasModule } from './modules/personas/personas.module';
import { PrestamosModule } from './modules/prestamos/prestamos.module';
import { TarjetasModule } from './modules/tarjetas/tarjetas.module';
import { ProductosFinancierosModule } from './modules/productos-financieros/productos-financieros.module';
import { SugerenciasModule } from './modules/sugerencias/sugerencias.module';
import { PrismaModule } from './prisma/prisma.module';

/** Aplana los errores de class-validator a `{ campo: [mensajes] }` (cuerpo 400 legacy: `{message:"Datos inválidos", errors}`). */
function flattenValidationErrors(errors: ValidationError[], prefix = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) out[path] = Object.values(error.constraints);
    if (error.children?.length) Object.assign(out, flattenValidationErrors(error.children, path));
  }
  return out;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    HomeModule,
    LookupModule,
    PersonasModule,
    TarjetasModule,
    ProductosFinancierosModule,
    SugerenciasModule,
    ComprasCreditoModule,
    ConsultasPagosModule,
    PrestamosModule,
    CuentasFinancierasModule,
    TransaccionesModule,
    NotificacionesCorreoModule,
    GastosRecurrentesModule,
    ObligacionesAportesModule,
    RecurrentesPersonaModule,
    LiquidacionMensualModule,
    EstadoCuentaPersonasModule,
    DashboardModule,
    AnaliticaModule,
    EventosGrupalesModule,
    CobrosModule,
    SubledgerDeudasModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: JsonSerializationInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: true,
        exceptionFactory: (errors) => datosInvalidos(flattenValidationErrors(errors)),
      }),
    },
  ],
})
export class AppModule {}
