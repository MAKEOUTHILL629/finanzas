import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnaliticaService } from './analitica.service';

class RetagDto {
  @IsOptional() @IsBoolean() soloSinTags?: boolean;
}
class ActualizarTagsDto {
  @IsIn(['COMPRA', 'TRANSACCION']) tipo!: 'COMPRA' | 'TRANSACCION';
  @Type(() => Number) @IsInt() id!: number;
  @IsArray() @IsString({ each: true }) tags!: string[];
  @IsOptional() @IsBoolean() crearRegla?: boolean;
}

@ApiTags('Analítica y tags')
@ApiBearerAuth()
@Controller('api/analitica')
export class AnaliticaController {
  constructor(private readonly analitica: AnaliticaService) {}

  @Post('retag-historico')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-etiqueta todo el historial (compras + egresos) con el motor de comercios y las reglas del usuario' })
  retag(@Body() dto: RetagDto, @CurrentUser('userId') userId: bigint) {
    return this.analitica.retag(userId, dto.soloSinTags);
  }

  @Get('consulta')
  @ApiOperation({ summary: '«Pregúntale a tu App»: gasto por tags/comercios/periodo en lenguaje natural' })
  consulta(@Query('q') q: string, @Query('desde') desde: string | undefined, @Query('hasta') hasta: string | undefined, @CurrentUser('userId') userId: bigint) {
    return this.analitica.consulta(userId, q ?? '', desde, hasta);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Catálogo de etiquetas del usuario' })
  tags(@CurrentUser('userId') userId: bigint) {
    return this.analitica.listarTags(userId);
  }

  @Post('tags')
  @HttpCode(200)
  @ApiOperation({ summary: 'Edita los tags de una compra/transacción; con crearRegla aprende la regla para ese comercio' })
  actualizarTags(@Body() dto: ActualizarTagsDto, @CurrentUser('userId') userId: bigint) {
    return this.analitica.actualizarTags(userId, dto);
  }
}
