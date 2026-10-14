import { Injectable } from '@nestjs/common';
import { Prisma, ResponsablesComprasCredito } from '@prisma/client';
import { toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { idNum, num, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from './compras-credito.service';
import { CreateResponsableDto, UpdateResponsableDto } from './dto/responsable.dto';

/**
 * Equivale a `ResponsablesCompraCreditoRepositorio` + `ResponsableCompraCreditoControlador`.
 *
 * Sub-ledger (`MovimientosDeudaPersona`): el Trigger 6 (`trg_after_insert_responsable_tc`) crea/actualiza los cargos
 * `CARGO_CUOTA_TC` en INSERT y UPDATE. Aquí NO se insertan asientos; solo se limpian los que el trigger no puede
 * eliminar (al borrar un responsable o reducir su `cantidad_cuotas`).
 */
@Injectable()
export class ResponsablesService {
  constructor(private readonly prisma: PrismaService) {}

  async listByCompra(compraId: number, ownerUserId: bigint) {
    const responsables = await this.prisma.responsablesComprasCredito.findMany({
      where: { compra_credito: BigInt(compraId), compra_credito_ref: { owner_user_id: ownerUserId } },
      orderBy: { id: 'asc' },
    });
    return responsables.map((r) => this.toJson(r));
  }

  /** Inserta DESPUÉS de que existan las cuotas (las crea `ComprasCreditoService.save`); el Trigger 6 hace el resto. */
  async create(dto: CreateResponsableDto, ownerUserId: bigint): Promise<number> {
    return this.prisma.$transaction((tx) => this.createTx(tx, dto, ownerUserId), TX_OPTIONS);
  }

  async createTx(tx: Prisma.TransactionClient, dto: CreateResponsableDto, ownerUserId: bigint): Promise<number> {
    await this.assertCompraYPersona(tx, BigInt(dto.compraCredito), BigInt(dto.persona), ownerUserId);
    const creado = await tx.responsablesComprasCredito.create({
      data: {
        persona: BigInt(dto.persona),
        porcentaje_pago: toDbRate(toDecimal(dto.porcentajePago)),
        cantidad_pago: toDbMoney(toDecimal(dto.cantidadPago)),
        cantidad_cuotas: dto.cantidadCuotas,
        compra_credito: BigInt(dto.compraCredito),
      },
    });
    return idNum(creado.id);
  }

  /** `compraCredito` se exige en el body pero NO se modifica (DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md). */
  async update(dto: UpdateResponsableDto, ownerUserId: bigint): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existente = await tx.responsablesComprasCredito.findFirst({
        where: { id: BigInt(dto.id), compra_credito_ref: { owner_user_id: ownerUserId } },
      });
      if (!existente) throw new Error(`No se encontró el responsable con ID ${dto.id}`);
      await this.assertPersona(tx, BigInt(dto.persona), ownerUserId);

      // El trigger solo hace upsert de cuotas <= cantidad_cuotas: retiramos los asientos de cuotas que ya no aplican.
      await tx.$executeRaw`
        DELETE FROM "MovimientosDeudaPersona" m
        USING "CuotasDetalle" cd
        WHERE m.responsable_compra_id = ${existente.id}::int8
          AND m.cuota_detalle_id = cd.id
          AND cd.numero_cuota > ${dto.cantidadCuotas}::int8`;

      await tx.responsablesComprasCredito.update({
        where: { id: existente.id },
        data: {
          persona: BigInt(dto.persona),
          porcentaje_pago: toDbRate(toDecimal(dto.porcentajePago)),
          cantidad_pago: toDbMoney(toDecimal(dto.cantidadPago)),
          cantidad_cuotas: dto.cantidadCuotas,
        },
      });
    }, TX_OPTIONS);
  }

  async delete(id: number, ownerUserId: bigint): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existente = await tx.responsablesComprasCredito.findFirst({
        where: { id: BigInt(id), compra_credito_ref: { owner_user_id: ownerUserId } },
        select: { id: true },
      });
      if (!existente) throw new Error(`No se encontró el responsable con ID ${id}`);
      await tx.movimientosDeudaPersona.deleteMany({ where: { responsable_compra_id: existente.id } });
      await tx.responsablesComprasCredito.delete({ where: { id: existente.id } });
    }, TX_OPTIONS);
  }

  private async assertCompraYPersona(
    tx: Prisma.TransactionClient,
    compraId: bigint,
    personaId: bigint,
    ownerUserId: bigint,
  ): Promise<void> {
    const compra = await tx.comprasCredito.findFirst({
      where: { id: compraId, owner_user_id: ownerUserId },
      select: { id: true },
    });
    if (!compra) throw new Error(`No se encontró la compra con ID ${compraId}`);
    await this.assertPersona(tx, personaId, ownerUserId);
  }

  private async assertPersona(
    tx: Prisma.TransactionClient,
    personaId: bigint,
    ownerUserId: bigint,
  ): Promise<void> {
    const persona = await tx.personas.findFirst({
      where: { id: personaId, owner_user_id: ownerUserId },
      select: { id: true },
    });
    if (!persona) throw new Error(`No se encontró la persona con ID ${personaId}`);
  }

  private toJson(r: ResponsablesComprasCredito) {
    return {
      id: idNum(r.id),
      fechaCreacion: timestampToDayMillis(r.created_at),
      persona: idNum(r.persona),
      porcentajePago: num(r.porcentaje_pago),
      cantidadPago: num(r.cantidad_pago),
      cantidadCuotas: r.cantidad_cuotas ?? 0,
      compraCredito: idNum(r.compra_credito),
    };
  }
}
