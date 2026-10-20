import { Body, Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CobroPublicoService } from './cobro-publico.service';
import { ReportarPagoDto } from './dto/cobros.dto';
import { ObjetarCobroDto } from './dto/cobros-fase6.dto';

/**
 * Páginas públicas para la persona a la que se le cobra (sin iniciar sesión). El acceso lo da el token del enlace, que es
 * largo y aleatorio. Las respuestas no se guardan en caché ni se indexan.
 */
@ApiTags('Cobros públicos')
@Controller('api/publico/cobros')
export class CobroPublicoController {
  constructor(private readonly publico: CobroPublicoService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({ summary: 'Detalle de lo que debe la persona en el mes y estado de los pagos que ha reportado' })
  ver(@Param('token') token: string) {
    return this.publico.ver(token);
  }

  @Public()
  @Post(':token/pagos')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'La persona informa un pago y adjunta su comprobante; queda pendiente de que el propietario lo apruebe' })
  reportar(@Param('token') token: string, @Body() dto: ReportarPagoDto) {
    return this.publico.reportar(token, dto);
  }

  @Public()
  @Post(':token/objeciones')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'La persona observa un cobro (o el total) con un comentario obligatorio; el propietario lo revisa y responde' })
  objetar(@Param('token') token: string, @Body() dto: ObjetarCobroDto) {
    return this.publico.objetar(token, dto);
  }

  @Public()
  @Get(':token/metodos/:id/qr')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({ summary: 'Imagen del QR de un medio de pago del propietario' })
  async qr(@Param('token') token: string, @Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const q = await this.publico.qrMetodo(token, id);
    res.set({ 'Content-Type': q.tipo, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=300' });
    return new StreamableFile(q.datos);
  }
}

/**
 * Portal público del acreedor (Fase 6): quien te prestó abre su enlace sin contraseña y ve el
 * estado del préstamo, a qué cuenta se le pagó y los comprobantes. Ruta raíz `/api/publico`.
 */
@ApiTags('Portal público del acreedor')
@Controller('api/publico')
export class PortalAcreedorController {
  constructor(private readonly publico: CobroPublicoService) {}

  @Public()
  @Get('comprobante-prestamo/:token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({ summary: 'Estado del préstamo POR_PAGAR y comprobantes para el acreedor (sin JWT)' })
  ver(@Param('token') token: string) {
    return this.publico.verComprobantePrestamo(token);
  }

  @Public()
  @Get('comprobante-prestamo/:token/abonos/:abonoId/comprobante')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({ summary: 'Descarga el comprobante de un abono' })
  async comprobante(@Param('token') token: string, @Param('abonoId', ParseIntPipe) abonoId: number, @Res({ passthrough: true }) res: Response) {
    const q = await this.publico.comprobantePrestamo(token, abonoId);
    res.set({ 'Content-Type': q.tipo, 'Content-Disposition': `attachment; filename="${q.nombre}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' });
    return new StreamableFile(q.datos);
  }
}
