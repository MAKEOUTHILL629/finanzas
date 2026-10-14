import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CuentasFinancierasService } from './cuentas-financieras.service';
import {
  CreateCategoriaDto,
  CreateCuentaFinancieraDto,
  UpdateCategoriaDto,
  UpdateCuentaFinancieraDto,
} from './dto/cuenta-categoria.dto';

@ApiTags('Cuentas financieras')
@ApiBearerAuth()
@Controller('api/cuentas-financieras')
export class CuentasFinancierasController {
  constructor(private readonly cuentas: CuentasFinancierasService) {}

  @Get()
  @ApiQuery({ name: 'soloActivas', required: false, type: Boolean })
  list(@CurrentUser('userId') userId: bigint, @Query('soloActivas') soloActivas?: string) {
    return this.cuentas.list(userId, soloActivas === 'true');
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint) {
    return this.cuentas.get(id, userId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea una cuenta; saldo_actual solo se inicializa aquí (luego lo mantiene el Trigger 2)' })
  create(@Body() dto: CreateCuentaFinancieraDto, @CurrentUser('userId') userId: bigint) {
    return this.cuentas.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edita la cuenta (saldo_actual NO es editable: lo mantiene el Trigger 2)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCuentaFinancieraDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cuentas.update(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCuentaFinancieraDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cuentas.update(id, dto, userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint): Promise<void> {
    await this.cuentas.remove(id, userId);
  }
}

@ApiTags('Categorías')
@ApiBearerAuth()
@Controller('api/categorias')
export class CategoriasController {
  constructor(private readonly cuentas: CuentasFinancierasService) {}

  @Get()
  @ApiQuery({ name: 'tipo', required: false, enum: ['INGRESO', 'EGRESO', 'AMBOS'] })
  @ApiOperation({ summary: 'Categorías del sistema + las personalizadas del usuario' })
  list(@CurrentUser('userId') userId: bigint, @Query('tipo') tipo?: string) {
    return this.cuentas.listCategorias(userId, tipo);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateCategoriaDto, @CurrentUser('userId') userId: bigint) {
    return this.cuentas.createCategoria(dto, userId);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoriaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cuentas.updateCategoria(id, dto, userId);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoriaDto,
    @CurrentUser('userId') userId: bigint,
  ) {
    return this.cuentas.updateCategoria(id, dto, userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser('userId') userId: bigint): Promise<void> {
    await this.cuentas.removeCategoria(id, userId);
  }
}
