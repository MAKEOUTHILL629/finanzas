import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { errorMessage, legacyTry } from '../../common/utils/legacy-http.util';
import { PagosService } from './pagos.service';
import { ComprasCreditoCsvService } from './compras-credito-csv.service';
import { ComprasCreditoService } from './compras-credito.service';
import { ActualizarCompraCreditoDto, CreateCompraCreditoDto, UpdateCompraCreditoDto } from './dto/compra-credito.dto';

/**
 * Equivale a `ComprasCreditoControlador.scala`. Las rutas estáticas se declaran antes que las paramétricas
 * (Play resuelve por orden de archivo; Nest por orden de registro).
 * Todas las respuestas exitosas son 200 (no 201), como el legacy.
 */
@ApiTags('Compras Crédito')
@ApiBearerAuth()
@Controller()
export class ComprasCreditoController {
  constructor(
    private readonly compras: ComprasCreditoService,
    private readonly csv: ComprasCreditoCsvService,
    private readonly pagos: PagosService,
  ) {}

  @Get('api/compras-credito')
  @ApiOperation({ summary: 'Listar compras a crédito del usuario' })
  list(@CurrentUser('userId') userId: bigint) {
    return this.compras.list(userId);
  }

  /** `null` (Json.toJson(None)) si la compra no existe. */
  @Get('api/compras-credito/detalle/:id')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async detalle(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return (await this.compras.getById(id, userId)) ?? 'null';
  }

  @Post('api/compras-credito')
  @HttpCode(200)
  @ApiOperation({ summary: 'Crear compra a crédito y generar su tabla de cuotas' })
  async create(@Body() dto: CreateCompraCreditoDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al crear la compra a crédito', async () => {
      const id = await this.compras.save(dto, userId);
      return { message: 'Compra a crédito creada exitosamente', id };
    });
  }

  @Put('api/compras-credito')
  @ApiOperation({ summary: 'Actualizar compra y recalcular cuotas' })
  async update(@Body() dto: UpdateCompraCreditoDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al actualizar la compra a crédito', async () => {
      await this.compras.updateCompra(dto.id, dto, userId);
      return { message: 'Compra a crédito actualizada exitosamente' };
    });
  }

  /** Variante REST con el id en la ruta (el contrato legacy `PUT /api/compras-credito` con id en el body sigue vigente). */
  @Put('api/compras-credito/:id')
  @ApiOperation({ summary: 'Actualizar compra por id en la ruta y recalcular cuotas' })
  async updateById(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarCompraCreditoDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return legacyTry('Error al actualizar la compra a crédito', async () => {
      await this.compras.updateCompra(id, dto, userId);
      return { message: 'Compra a crédito actualizada exitosamente' };
    });
  }

  @Post('api/compras-credito/upload-csv')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Carga masiva de compras desde CSV (devuelve el CSV con columna Resultado)' })
  async uploadCsv(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser('userId') userId: bigint,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!file) {
      throw new HttpException({ message: 'No se encontró el archivo en la solicitud' }, HttpStatus.BAD_REQUEST);
    }
    let contenido: string;
    try {
      contenido = file.buffer.toString('utf8');
    } catch (error) {
      throw new HttpException(
        { message: `Error al leer el archivo CSV: ${errorMessage(error)}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    const csv = await legacyTry('Error al procesar CSV', async () => (await this.csv.procesar(contenido, userId)).csv);
    // Las cabeceras de descarga se fijan solo en éxito: los errores (400/500) siguen siendo JSON.
    res.set({
      'Content-Disposition': 'attachment; filename=resultado_compras.csv',
      'Content-Type': 'text/csv; charset=utf-8',
    });
    return csv;
  }

  /** Marca como 'Pagado' las compras pendientes cuya última cuota ya venció. Devuelve `true`. */
  @Post('api/compras-credito/pagar-productos')
  @HttpCode(200)
  @Header('Content-Type', 'application/json; charset=utf-8')
  async pagarProductos(@CurrentUser('userId') userId: bigint) {
    await this.pagos.pagarProductosTarjetaCredito(userId);
    return 'true';
  }

  @Post('api/compras-credito/ajustar-interes-compras/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ajuste de interés de las compras pendientes de una tarjeta' })
  async ajustarInteres(@Param('id', ParseIntPipe) tarjetaId: number, @CurrentUser('userId') userId: bigint) {
    await this.compras.ajusteInteresTarjetaCredito(tarjetaId, userId);
    return { message: 'Estado cambiado' };
  }

  /** El legacy responde con el entero `updateResult` (no con la lista de cuotas que dice el OpenAPI). */
  @Post('api/recalcular-compra-credito')
  @HttpCode(200)
  @Header('Content-Type', 'application/json; charset=utf-8')
  @ApiOperation({ summary: 'Recalcular cuotas de una compra (devuelve filas afectadas)' })
  async recalcular(@Body() dto: UpdateCompraCreditoDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al recalcular las cuotas', async () =>
      String(await this.compras.updateCompra(dto.id, dto, userId)),
    );
  }

  @Delete('api/compras-credito/:id')
  @ApiOperation({ summary: 'Eliminar compra en cascada (sub-ledger, responsables, cuotas, compra)' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al eliminar la compra a crédito', async () => {
      await this.compras.delete(id, userId);
      return { message: 'Compra a crédito eliminada exitosamente' };
    });
  }
}
