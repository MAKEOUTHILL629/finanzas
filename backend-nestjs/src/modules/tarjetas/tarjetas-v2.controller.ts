import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { ActualizarTarjetaDto } from './dto/actualizar-tarjeta.dto';
import { CrearTarjetaDto } from './dto/crear-tarjeta.dto';
import { PagarExtractoDto } from './dto/pagar-extracto.dto';
import { TarjetasService } from './tarjetas.service';

@ApiTags('Tarjetas v2')
@ApiBearerAuth()
@Controller('api/tarjetas')
export class TarjetasV2Controller {
  constructor(private readonly tarjetas: TarjetasService) {}

  @Get('resumen-mensual')
  @ApiQuery({ name: 'periodo', required: true, example: '2026-10' })
  @ApiOperation({ summary: 'Resumen mensual por tarjeta: lo tuyo vs. lo de terceros + componente USD (consulta 7.3)' })
  resumenMensual(@Query('periodo') periodo: string | undefined, @CurrentUser('userId') userId: bigint) {
    if (!periodo) throw datosInvalidos({ periodo: ['periodo es obligatorio (YYYY-MM)'] });
    return this.tarjetas.resumenMensual(periodo, userId);
  }

  @Post()
  @ApiOperation({ summary: 'Crea una tarjeta (crédito o débito) con su plástico, o un plástico que renueva a otro; sin límite por cuenta ni franquicia' })
  crear(@Body() dto: CrearTarjetaDto, @CurrentUser('userId') userId: bigint) {
    return this.tarjetas.crear(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edita la configuración de una tarjeta: día de corte, límite de pago, cupo, tasas…' })
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarTarjetaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.tarjetas.actualizar(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  actualizarParcial(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarTarjetaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.tarjetas.actualizar(id, dto, userId);
  }

  @Post(':id/pagar-extracto')
  @HttpCode(200)
  @ApiOperation({ summary: 'Paga el extracto de una tarjeta (SELECT sp_pagar_extracto_tarjeta)' })
  pagarExtracto(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PagarExtractoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.tarjetas.pagarExtracto(id, userId, dto);
  }
}
