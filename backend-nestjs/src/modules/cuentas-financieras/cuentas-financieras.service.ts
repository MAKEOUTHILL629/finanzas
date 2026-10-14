import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCategoriaDto,
  CreateCuentaFinancieraDto,
  UpdateCategoriaDto,
  UpdateCuentaFinancieraDto,
} from './dto/cuenta-categoria.dto';

@Injectable()
export class CuentasFinancierasService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── Cuentas ─────────────────────────────

  list(ownerUserId: bigint, soloActivas = false) {
    return this.prisma.cuentasFinancieras.findMany({
      where: { owner_user_id: ownerUserId, ...(soloActivas ? { is_active: true } : {}) },
      orderBy: { id: 'asc' },
    });
  }

  async get(id: number, ownerUserId: bigint) {
    const cuenta = await this.prisma.cuentasFinancieras.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!cuenta) throw new NotFoundException(`Cuenta financiera ${id} no encontrada`);
    return cuenta;
  }

  /** `saldo_actual` se inicializa aquí; después solo cambia por el Trigger 2 (nunca con UPDATE desde NestJS). */
  create(dto: CreateCuentaFinancieraDto, ownerUserId: bigint) {
    return this.prisma.cuentasFinancieras.create({
      data: {
        owner_user_id: ownerUserId,
        nombre: dto.nombre,
        tipo_cuenta: dto.tipoCuenta,
        banco_entidad: dto.bancoEntidad ?? null,
        ultimos_4_digitos: dto.ultimos4Digitos ?? null,
        moneda: (dto.moneda ?? 'COP').toUpperCase(),
        saldo_actual: toDbMoney(toDecimal(dto.saldoInicial ?? 0)),
        is_active: true,
      },
    });
  }

  async update(id: number, dto: UpdateCuentaFinancieraDto, ownerUserId: bigint) {
    const cuenta = await this.get(id, ownerUserId);
    const data: Prisma.CuentasFinancierasUncheckedUpdateInput = {};
    if (dto.nombre !== undefined) data.nombre = dto.nombre;
    if (dto.tipoCuenta !== undefined) data.tipo_cuenta = dto.tipoCuenta;
    if (dto.bancoEntidad !== undefined) data.banco_entidad = dto.bancoEntidad;
    if (dto.ultimos4Digitos !== undefined) data.ultimos_4_digitos = dto.ultimos4Digitos;
    if (dto.isActive !== undefined) data.is_active = dto.isActive;
    return this.prisma.cuentasFinancieras.update({ where: { id: cuenta.id }, data });
  }

  /** Solo se elimina físicamente una cuenta sin movimientos; si no, se debe desactivar (`isActive=false`). */
  async remove(id: number, ownerUserId: bigint): Promise<void> {
    const cuenta = await this.get(id, ownerUserId);
    const movimientos = await this.prisma.transacciones.count({
      where: { OR: [{ cuenta_origen_id: cuenta.id }, { cuenta_destino_id: cuenta.id }] },
    });
    if (movimientos > 0) {
      throw new ConflictException(
        `La cuenta tiene ${movimientos} transacción(es); desactívala con PATCH { "isActive": false } en lugar de eliminarla`,
      );
    }
    await this.prisma.cuentasFinancieras.delete({ where: { id: cuenta.id } });
  }

  // ───────────────────────────── Categorías ─────────────────────────────

  /** Categorías del sistema (`owner_user_id IS NULL`) + las personalizadas del usuario. */
  listCategorias(ownerUserId: bigint, tipo?: string) {
    return this.prisma.categorias.findMany({
      where: {
        OR: [{ owner_user_id: null }, { owner_user_id: ownerUserId }],
        ...(tipo ? { tipo: { in: [tipo, 'AMBOS'] } } : {}),
      },
      orderBy: [{ owner_user_id: { sort: 'asc', nulls: 'first' } }, { nombre: 'asc' }],
    });
  }

  createCategoria(dto: CreateCategoriaDto, ownerUserId: bigint) {
    return this.prisma.categorias.create({
      data: {
        owner_user_id: ownerUserId,
        nombre: dto.nombre,
        tipo: dto.tipo,
        icono: dto.icono ?? null,
        color: dto.color ?? null,
      },
    });
  }

  async updateCategoria(id: number, dto: UpdateCategoriaDto, ownerUserId: bigint) {
    const categoria = await this.requireCategoriaPropia(id, ownerUserId);
    const data: Prisma.CategoriasUncheckedUpdateInput = {};
    if (dto.nombre !== undefined) data.nombre = dto.nombre;
    if (dto.tipo !== undefined) data.tipo = dto.tipo;
    if (dto.icono !== undefined) data.icono = dto.icono;
    if (dto.color !== undefined) data.color = dto.color;
    return this.prisma.categorias.update({ where: { id: categoria.id }, data });
  }

  async removeCategoria(id: number, ownerUserId: bigint): Promise<void> {
    const categoria = await this.requireCategoriaPropia(id, ownerUserId);
    const [transacciones, plantillas] = await Promise.all([
      this.prisma.transacciones.count({ where: { categoria_id: categoria.id } }),
      this.prisma.plantillasRecurrentes.count({ where: { categoria_id: categoria.id } }),
    ]);
    if (transacciones + plantillas > 0) {
      throw new ConflictException('La categoría está en uso (transacciones o plantillas recurrentes) y no se puede eliminar');
    }
    await this.prisma.categorias.delete({ where: { id: categoria.id } });
  }

  /** Las categorías del sistema son de solo lectura. */
  private async requireCategoriaPropia(id: number, ownerUserId: bigint) {
    const categoria = await this.prisma.categorias.findFirst({
      where: { id: BigInt(id), OR: [{ owner_user_id: null }, { owner_user_id: ownerUserId }] },
    });
    if (!categoria) throw new NotFoundException(`Categoría ${id} no encontrada`);
    if (categoria.owner_user_id === null) throw new ForbiddenException('Las categorías del sistema no se pueden modificar');
    return categoria;
  }
}
