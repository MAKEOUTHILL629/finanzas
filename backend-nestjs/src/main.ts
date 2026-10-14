import './config/decimal.config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 9000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Finanzas API escuchando en el puerto ${port} (docs: /api/docs, legacy: /api-docs)`);
}

void bootstrap();
