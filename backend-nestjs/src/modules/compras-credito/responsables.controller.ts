import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { legacyTry } from '../../common/utils/legacy-http.util';
import { CreateResponsableDto, UpdateResponsableDto } from './dto/responsable.dto';
import { ResponsablesService } from './responsables.service';

/** Equivale a `ResponsableCompraCreditoControlador.scala`. */
@ApiTags('Responsables')
@ApiBearerAuth()
@Controller('api/compras-credito')
export class ResponsablesController {
  constructor(private readonly responsables: ResponsablesService) {}

  @Get(':id/responsables')
  listByCompra(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.responsables.listByCompra(id, userId);
  }

  @Post('responsables')
  @HttpCode(200)
  async create(@Body() dto: CreateResponsableDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al crear el responsable', async () => {
      const id = await this.responsables.create(dto, userId);
      return { message: 'Responsable de compra a crédito creado exitosamente', id };
    });
  }

  @Put('responsables')
  async update(@Body() dto: UpdateResponsableDto, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al actualizar el responsable', async () => {
      await this.responsables.update(dto, userId);
      return { message: 'Responsable actualizado exitosamente' };
    });
  }

  @Delete('responsables/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return legacyTry('Error al eliminar el responsable', async () => {
      await this.responsables.delete(id, userId);
      return { message: 'Responsable eliminado exitosamente' };
    });
  }
}
