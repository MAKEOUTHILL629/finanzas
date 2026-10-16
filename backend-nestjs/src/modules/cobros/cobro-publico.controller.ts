import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CobroPublicoService } from './cobro-publico.service';
import { ReportarPagoDto } from './dto/cobros.dto';

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
}
