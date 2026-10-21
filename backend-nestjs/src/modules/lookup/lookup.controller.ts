import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { LookupService, parseTipos, TIPOS_CATALOGO } from './lookup.service';

const AYUDA_TIPOS = `Uno o varios de: ${TIPOS_CATALOGO.join(', ')}`;

/** Catálogos ligeros para los selectores de los formularios. Siempre `200` con arreglos (vacíos si no hay datos). */
@ApiTags('Lookup')
@ApiBearerAuth()
@Controller('api/lookup')
export class LookupController {
  constructor(private readonly lookup: LookupService) {}

  @Get()
  @ApiOperation({ summary: 'Catálogos para selectores (personas, tarjetas, cuentas, categorías) en una sola llamada' })
  @ApiQuery({ name: 'tipos', required: false, description: `${AYUDA_TIPOS}. Sin valor = todos.`, example: 'personas,cuentas' })
  catalogos(@Query('tipos') tipos: string | undefined, @CurrentUser('userId') userId: bigint) {
    const lista = parseTipos(tipos);
    if (!lista) throw datosInvalidos({ tipos: [AYUDA_TIPOS] });
    return this.lookup.catalogos(userId, lista);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Catálogo de tags existentes con frecuencia de uso y color sugerido' })
  tags(@CurrentUser('userId') userId: bigint) {
    return this.lookup.tags(userId);
  }

  @Get(':tipo')
  @ApiOperation({ summary: 'Un catálogo como arreglo plano' })
  @ApiParam({ name: 'tipo', enum: TIPOS_CATALOGO })
  async uno(@Param('tipo') tipo: string, @CurrentUser('userId') userId: bigint) {
    const lista = parseTipos(tipo);
    if (!lista || lista.length !== 1) throw datosInvalidos({ tipo: [AYUDA_TIPOS] });
    const r = await this.lookup.catalogos(userId, lista);
    return r[lista[0]] ?? [];
  }
}
