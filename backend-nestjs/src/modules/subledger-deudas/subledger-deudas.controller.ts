import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { AbonarPersonaDto, CreateCruceDeudaDto } from './dto/subledger.dto';
import { SubledgerDeudasService } from './subledger-deudas.service';

function periodoRequerido(periodo: string | undefined): string {
  if (!periodo) throw datosInvalidos({ periodo: ['periodo es obligatorio (YYYY-MM)'] });
  return periodo;
}

@ApiTags('Sub-ledger de deudas')
@ApiBearerAuth()
@Controller('api')
export class SubledgerDeudasController {
  constructor(private readonly subledger: SubledgerDeudasService) {}

  @Get('cruces-deuda')
  listCruces(@CurrentUser('userId') userId: bigint) {
    return this.subledger.listCruces(userId);
  }

  @Post('cruces-deuda')
  @HttpCode(201)
  @ApiOperation({ summary: 'Cruce triangular de deuda; el Trigger 5 genera los asientos -1 y +1' })
  crearCruce(@Body() dto: CreateCruceDeudaDto, @CurrentUser('userId') userId: bigint) {
    return this.subledger.crearCruce(dto, userId);
  }

  @Post('personas/:id/abonar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registra el pago/reembolso de una persona (SELECT sp_registrar_abono_persona)' })
  abonar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AbonarPersonaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.subledger.abonarPersona(id, dto, userId);
  }

  @Get('ledger/estado-cuenta')
  @ApiQuery({ name: 'periodo', required: true, example: '2026-10' })
  @ApiOperation({ summary: 'Estado de cuenta consolidado por persona a fin de mes (consulta 7.1)' })
  estadoCuenta(@Query('periodo') periodo: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.subledger.estadoCuenta(periodoRequerido(periodo), userId);
  }

  @Get('ledger/personas/:personaId/extracto')
  @ApiQuery({ name: 'periodo', required: true, example: '2026-10' })
  @ApiOperation({ summary: 'Extracto detallado de una persona en un mes (consulta 7.2)' })
  extracto(
    @Param('personaId', ParseIntPipe) personaId: number,
    @Query('periodo') periodo: string | undefined,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.subledger.extracto(personaId, periodoRequerido(periodo), userId);
  }

  @Get('analytics/flujo-caja')
  @ApiQuery({ name: 'periodo', required: true, example: '2026-10' })
  @ApiOperation({ summary: 'Pronóstico de flujo de caja mensual: ingresos vs. tarjetas + recurrentes + obligaciones (7.4)' })
  flujoCaja(@Query('periodo') periodo: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.subledger.flujoCaja(periodoRequerido(periodo), userId);
  }
}
