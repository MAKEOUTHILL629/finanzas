import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTransaccionDto, TransaccionesFiltroDto, UpdateTransaccionDto } from './dto/transaccion.dto';
import { TransaccionesService } from './transacciones.service';

@ApiTags('Transacciones')
@ApiBearerAuth()
@Controller('api/transacciones')
export class TransaccionesController {
  constructor(private readonly transacciones: TransaccionesService) {}

  @Get()
  @ApiOperation({ summary: 'Libro diario filtrado por fechas, cuenta, categoría, tipo y estado (paginado)' })
  list(@Query() filtro: TransaccionesFiltroDto, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.list(userId, filtro);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.get(id, userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Registra un ingreso, egreso, transferencia, pago de tarjeta/préstamo o reembolso',
    description:
      'El saldo de las cuentas lo ajusta el Trigger 2 solo cuando estado = CONFIRMADO. ' +
      'Una TRANSFERENCIA es una sola fila que afecta ambas cuentas.',
  })
  create(@Body() dto: CreateTransaccionDto, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edita la transacción (el Trigger 2 revierte el impacto anterior y aplica el nuevo)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTransaccionDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.transacciones.update(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTransaccionDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.transacciones.update(id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Anula la transacción (estado ANULADO); el Trigger 2 revierte el saldo' })
  anular(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.anular(id, userId);
  }
}
