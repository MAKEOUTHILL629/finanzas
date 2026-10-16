import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos, parseIntStrict } from '../../common/utils/legacy-http.util';
import { ActualizarPlasticoDto, AgregarPlasticoDto, ReemplazarPlasticoDto } from './dto/plasticos.dto';
import { PlasticosTarjetaService } from './plasticos-tarjeta.service';

/** Plásticos (renovaciones/reposiciones) de una tarjeta de crédito e historial unificado de sus compras. */
@ApiTags('Tarjetas · plásticos')
@ApiBearerAuth()
@Controller('api/tarjetas/:id')
export class PlasticosController {
  constructor(private readonly plasticos: PlasticosTarjetaService) {}

  @Get('plasticos')
  @ApiOperation({ summary: 'Plásticos de la tarjeta (el activo primero)' })
  listar(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.plasticos.listar(id, userId);
  }

  @Post('plasticos')
  @ApiOperation({ summary: 'Agrega un plástico histórico (o el primero de la línea) sin cambiar el activo; el historial de compras queda intacto' })
  agregar(@Param('id', ParseIntPipe) id: number, @Body() dto: AgregarPlasticoDto, @CurrentUser('userId') userId: bigint) {
    return this.plasticos.agregarHistorico(id, dto, userId);
  }

  @Post('plasticos/reemplazar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registrar reemplazo / nuevo plástico: archiva el activo y deja intacto el historial de compras y cuotas' })
  reemplazar(@Param('id', ParseIntPipe) id: number, @Body() dto: ReemplazarPlasticoDto, @CurrentUser('userId') userId: bigint) {
    return this.plasticos.reemplazar(id, dto, userId);
  }

  @Patch('plasticos/:plasticoId')
  @ApiOperation({ summary: 'Corrige fechas/notas de un plástico o lo vuelve el activo' })
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Param('plasticoId', ParseIntPipe) plasticoId: number,
    @Body() dto: ActualizarPlasticoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.plasticos.actualizar(id, plasticoId, dto, userId);
  }

  @Delete('plasticos/:plasticoId')
  @ApiOperation({ summary: 'Elimina un plástico sin compras asociadas que no sea el activo' })
  eliminar(@Param('id', ParseIntPipe) id: number, @Param('plasticoId', ParseIntPipe) plasticoId: number, @CurrentUser('userId') userId: bigint) {
    return this.plasticos.eliminar(id, plasticoId, userId);
  }

  @Get('historial')
  @ApiOperation({ summary: 'Historial unificado de compras de la tarjeta (todos los plásticos), filtrable por plástico y fechas' })
  @ApiQuery({ name: 'plasticoId', required: false, type: Number })
  @ApiQuery({ name: 'desde', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'hasta', required: false, example: '2026-12-31' })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  historial(
    @Param('id', ParseIntPipe) id: number,
    @Query('plasticoId') plasticoId: string | undefined,
    @Query('desde') desde: string | undefined,
    @Query('hasta') hasta: string | undefined,
    @Query('pagina') pagina: string | undefined,
    @Query('limite') limite: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    const numero = (valor: string | undefined, campo: string): number | undefined => {
      if (valor === undefined || valor === '') return undefined;
      const n = parseIntStrict(valor);
      if (n === null || n < 1) throw datosInvalidos({ [campo]: [`${campo} debe ser un entero positivo`] });
      return n;
    };
    return this.plasticos.historial(
      id,
      { plasticoId: numero(plasticoId, 'plasticoId'), desde: desde || undefined, hasta: hasta || undefined, pagina: numero(pagina, 'pagina'), limite: numero(limite, 'limite') },
      userId,
    );
  }
}
