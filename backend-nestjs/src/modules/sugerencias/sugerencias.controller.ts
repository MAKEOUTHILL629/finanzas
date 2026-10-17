import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { VacioAUndefined } from '../../common/validators/normalizar-opcional.decorator';
import { SugerenciasService } from './sugerencias.service';

export class ComerciosQueryDto {
  @ApiPropertyOptional({ description: 'Texto que debe contener el comercio (sin importar mayúsculas ni tildes)' })
  @VacioAUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ description: 'Máximo de comercios (por defecto 300)', minimum: 1, maximum: 1000 })
  @VacioAUndefined()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** Valores por defecto y comercios habituales para que los formularios arranquen medio llenos (plan V2, fase 4). */
@ApiTags('Sugerencias')
@ApiBearerAuth()
@Controller('api/sugerencias')
export class SugerenciasController {
  constructor(private readonly sugerencias: SugerenciasService) {}

  @Get('formularios')
  @ApiOperation({ summary: 'Tarjeta, cuenta, cuotas y personas con las que arrancan los formularios, según tu historial reciente' })
  formularios(@CurrentUser('userId') userId: bigint) {
    return this.sugerencias.formularios(userId);
  }

  @Get('comercios')
  @ApiOperation({ summary: 'Comercios que ya usaste con lo habitual de cada uno (cuotas, tarjeta, categoría, cuenta, responsable)' })
  comercios(@Query() query: ComerciosQueryDto, @CurrentUser('userId') userId: bigint) {
    return this.sugerencias.comercios(userId, { q: query.q, limit: query.limit });
  }
}
