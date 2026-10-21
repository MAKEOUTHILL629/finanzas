import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  CrearTransferenciaInternaDto,
  CreateTransaccionDto,
  TransaccionesFiltroDto,
  UpdateTransaccionDto,
} from './dto/transaccion.dto';
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

  @Post('transferencia-propia')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Iteración 2 — Fase 4: Registra una transferencia entre cuentas propias con movimientos espejo vinculados',
    description:
      'Crea un movimiento EGRESO en cuentaOrigenId y su movimiento espejo INGRESO en cuentaDestinoId (ambos con es_transferencia_interna = true), ' +
      'ajustando atómicamente los saldos de ambas cuentas sin inflar los totales de ingresos o gastos del mes.',
  })
  crearTransferenciaPropia(@Body() dto: CrearTransferenciaInternaDto, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.crearTransferenciaEntreCuentasPropias(dto, userId);
  }

  @Post('analizar-patrones-transferencias')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fase 5: extrae llaves, cuentas, nombres y entidad de las transferencias y aprende alias por persona' })
  analizarPatrones(@CurrentUser('userId') userId: bigint) {
    return this.transacciones.analizarPatronesTransferencias(userId);
  }

  @Get('analitica-transferencias')
  @ApiOperation({ summary: 'Fase 5: ranking por destinatario/llave/cuenta, serie mensual y distribución por entidad (acepta ?q=)' })
  analiticaTransferencias(@Query('q') q: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.transacciones.analiticaTransferencias(userId, q);
  }

  @Post('vincular-identificador-persona')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fase 5: vincula manualmente una llave/cuenta/celular a una persona y lo aplica a sus transferencias' })
  vincularIdentificador(
    @Body() dto: { personaId: number; tipoIdentificador: string; valorIdentificador: string; entidadBancaria?: string },
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.transacciones.vincularIdentificadorAPersona(userId, dto);
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
