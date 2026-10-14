import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { legacyTry } from '../../common/utils/legacy-http.util';
import { CreatePrestamoDto, PrestamosFiltroDto } from './dto/prestamo.dto';
import { PrestamosService } from './prestamos.service';

/** Equivale a `PrestamoControlador.scala`. */
@ApiTags('Préstamos')
@ApiBearerAuth()
@Controller('api/prestamos')
export class PrestamosController {
  constructor(private readonly prestamos: PrestamosService) {}

  /** Contrato legacy + columnas Supabase y aprobaciones. Filtros opcionales por query. */
  @Get()
  list(@Query() filtro: PrestamosFiltroDto, @CurrentUser('userId') userId: bigint) {
    return this.prestamos.listLegacy(userId, filtro);
  }

  @Post()
  @HttpCode(200)
  create(@Body() dto: CreatePrestamoDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al crear el prestamo', async () => {
      const id = await this.prestamos.create(dto, userId);
      return { message: 'Prestamo creado exitosamente', id };
    });
  }
}
