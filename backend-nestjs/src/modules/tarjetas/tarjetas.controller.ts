import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos, legacyTry, parseIntStrict } from '../../common/utils/legacy-http.util';
import { TarjetasService } from './tarjetas.service';

/** Equivale a `TarjetaControlador.scala` (los errores usan la clave `mensaje`, no `message`). */
@ApiTags('Tarjetas')
@ApiBearerAuth()
@Controller('api/tarjetas')
export class TarjetasController {
  constructor(private readonly tarjetas: TarjetasService) {}

  @Get()
  list(@CurrentUser('userId') userId: bigint) {
    return this.tarjetas.list(userId);
  }

  @Get('balance')
  @ApiQuery({ name: 'mes', required: true, type: Number })
  @ApiQuery({ name: 'year', required: true, type: Number })
  balance(
    @Query('mes') mesRaw: string | undefined,
    @Query('year') yearRaw: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    const mes = parseIntStrict(mesRaw);
    const year = parseIntStrict(yearRaw);
    if (mes === null || year === null || mes < 1 || mes > 12 || year < 1) throw datosInvalidos();
    return this.tarjetas.balance(mes, year, userId);
  }

  @Post('actualizar-tasas')
  @HttpCode(200)
  actualizarTasas(@CurrentUser('userId') userId: bigint) {
    return legacyTry('Error en el proceso de scraping', () => this.tarjetas.actualizarTodas(userId), 'mensaje');
  }

  @Post(':id/actualizar-tasas')
  @HttpCode(200)
  actualizarTasasTarjeta(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error inesperado', () => this.tarjetas.actualizarUna(id, userId), 'mensaje');
  }
}
