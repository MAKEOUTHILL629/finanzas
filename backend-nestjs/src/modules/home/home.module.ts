import { Module } from '@nestjs/common';
import { HomeController } from './home.controller';
import { SwaggerLegacyController } from './swagger-legacy.controller';

@Module({
  controllers: [HomeController, SwaggerLegacyController],
})
export class HomeModule {}
