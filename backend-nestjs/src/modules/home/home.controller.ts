import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/** Equivalente a `HomeController.scala`. */
@ApiTags('Health')
@Public()
@Controller()
export class HomeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  index() {
    return { application: 'Finanzas API', version: '1.0', status: 'running' };
  }

  /** Health check para ELB/ECS: verifica app y base de datos. */
  @Get('health')
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'UP', database: 'connected', timestamp: Date.now() };
    } catch (error) {
      throw new HttpException(
        { status: 'DOWN', database: 'disconnected', error: (error as Error).message, timestamp: Date.now() },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
