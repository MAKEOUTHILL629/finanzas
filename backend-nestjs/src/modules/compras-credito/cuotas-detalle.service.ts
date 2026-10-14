import { Injectable } from '@nestjs/common';
import { dateToMillis, idNum, num } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CuotasDetalleService {
  constructor(private readonly prisma: PrismaService) {}

  /** JSON idéntico a `Json.writes[CuotaDetalle]` del legacy. */
  async listByCompra(compraId: number, ownerUserId: bigint) {
    const cuotas = await this.prisma.cuotasDetalle.findMany({
      where: { compra: BigInt(compraId), compra_ref: { owner_user_id: ownerUserId } },
      orderBy: [{ numero_cuota: 'asc' }, { id: 'asc' }],
    });
    return cuotas.map((c) => ({
      id: idNum(c.id),
      numeroCuota: idNum(c.numero_cuota),
      fechaPago: dateToMillis(c.fecha_pago),
      saldoRestante: num(c.saldo_restante),
      interesPagado: num(c.interes_pagado),
      aporteCapital: num(c.aporte_capital),
      pagoTotal: num(c.pago_total),
      compra: idNum(c.compra),
      estado: c.estado,
      periodoFacturacion: c.periodo_facturacion,
    }));
  }
}
