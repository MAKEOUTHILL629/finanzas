import { Injectable, NotFoundException } from '@nestjs/common';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AporteCuotaItem, calcularCuotaColaborativa, ModalidadAporteCuota } from './aportes-cuota.calc';

@Injectable()
export class AportesCuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Línea de tiempo de cuotas de una compra con sus aportes colaborativos (Fase 5). */
  async listarPorCompra(compraId: number, ownerUserId: bigint) {
    const compra = await this.prisma.comprasCredito.findFirst({
      where: { id: BigInt(compraId), owner_user_id: ownerUserId },
      include: { tarjeta_ref: { select: { es_titular_externo: true, titular_persona_id: true, franquicia: true, descripcion: true } } },
    });
    if (!compra) throw new NotFoundException(`Compra ${compraId} no encontrada`);
    const [cuotas, aportes] = await Promise.all([
      this.prisma.cuotasDetalle.findMany({ where: { compra: compra.id }, orderBy: [{ numero_cuota: 'asc' }, { id: 'asc' }] }),
      this.prisma.aportesColaborativosCuota.findMany({ where: { compra_credito_id: compra.id }, include: { aportante: { select: { nombre: true } } }, orderBy: { fecha_aporte: 'asc' } }),
    ]);
    return {
      compra: {
        id: idNum(compra.id),
        concepto: compra.concepto,
        valorCompra: money(toDecimal(compra.valor_compra)),
        esTarjetaTercero: compra.tarjeta_ref?.es_titular_externo === true,
        titularPersonaId: compra.tarjeta_ref?.titular_persona_id ? idNum(compra.tarjeta_ref.titular_persona_id) : null,
        tarjeta: compra.tarjeta_ref ? [compra.tarjeta_ref.franquicia, compra.tarjeta_ref.descripcion].filter(Boolean).join(' · ') : null,
      },
      cuotas: cuotas.map((c) => {
        const items: AporteCuotaItem[] = aportes
          .filter((a) => a.cuota_detalle_id === c.id)
          .map((a) => ({ aportantePersonaId: idNum(a.aportante_persona_id), monto: toDecimal(a.monto_aportado), modalidad: a.modalidad_entrega as ModalidadAporteCuota, fecha: a.fecha_aporte?.toISOString().slice(0, 10) ?? null }));
        return {
          cuotaDetalleId: idNum(c.id),
          numeroCuota: c.numero_cuota ? idNum(c.numero_cuota) : null,
          numeroCuotasTotal: compra.numero_cuotas ?? cuotas.length,
          fechaPago: c.fecha_pago?.toISOString().slice(0, 10) ?? null,
          estadoCuota: c.estado,
          aportes: aportes
            .filter((a) => a.cuota_detalle_id === c.id)
            .map((a) => ({ id: idNum(a.id), aportantePersonaId: idNum(a.aportante_persona_id), aportanteNombre: a.aportante?.nombre ?? null, monto: money(toDecimal(a.monto_aportado)), fecha: a.fecha_aporte?.toISOString().slice(0, 10) ?? null, modalidad: a.modalidad_entrega, observaciones: a.observaciones })),
          ...calcularCuotaColaborativa(toDecimal(c.pago_total), items),
        };
      }),
    };
  }

  async registrarAporte(cuotaId: number, ownerUserId: bigint, dto: { aportantePersonaId: number; monto: number | string; fecha?: string; modalidad?: ModalidadAporteCuota; observaciones?: string; comprobanteUrl?: string }) {
    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });
    const cuota = await this.prisma.cuotasDetalle.findFirst({ where: { id: BigInt(cuotaId), compra_ref: { owner_user_id: ownerUserId } }, include: { compra_ref: { select: { id: true } } } });
    if (!cuota?.compra_ref) throw new NotFoundException(`Cuota ${cuotaId} no encontrada`);
    const aportante = await this.prisma.personas.findFirst({ where: { id: BigInt(dto.aportantePersonaId), owner_user_id: ownerUserId }, select: { id: true } });
    if (!aportante) throw new NotFoundException(`Persona ${dto.aportantePersonaId} no encontrada`);
    const creado = await this.prisma.aportesColaborativosCuota.create({
      data: {
        cuota_detalle_id: cuota.id,
        compra_credito_id: cuota.compra_ref.id,
        aportante_persona_id: aportante.id,
        monto_aportado: toDbMoney(monto),
        fecha_aporte: dto.fecha ? new Date(`${dto.fecha}T00:00:00Z`) : new Date(),
        modalidad_entrega: dto.modalidad ?? 'TRANSFERIDO_A_MI',
        observaciones: dto.observaciones ?? null,
        comprobante_url: dto.comprobanteUrl ?? null,
      },
    });
    const detalle = await this.listarPorCompra(idNum(cuota.compra_ref.id), ownerUserId);
    return { aporteId: idNum(creado.id), cuota: detalle.cuotas.find((c) => c.cuotaDetalleId === cuotaId) ?? null, detalle };
  }
}
