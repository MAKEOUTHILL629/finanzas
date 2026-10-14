import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { todayLocal } from '../../common/utils/date.util';
import { dateToMillis, idNum, num } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';

interface PagoTarjetaRow {
  tarjeta: bigint;
  fecha_pago: Date;
  valor_pago: Prisma.Decimal;
}

interface CuotaMesRow {
  id: bigint;
  concepto: string | null;
  numero_cuota: bigint;
  numero_cuotas: number | null;
  fecha_pago: Date;
  saldo_restante: Prisma.Decimal;
  interes_pagado: Prisma.Decimal;
  aporte_capital: Prisma.Decimal;
  pago_total: Prisma.Decimal;
  compra: bigint;
  estado: string | null;
  tarjeta: bigint;
}

/** Equivale a `PagosServicio.scala`. Las sumas se hacen en PostgreSQL (numeric exacto), nunca con float. */
@Injectable()
export class PagosService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /api/tarjetas/pagos` — total por (tarjeta, fecha de pago), excluyendo cuotas en 'Ajuste Interes'. */
  async calcularPagoTarjetasCredito(ownerUserId: bigint) {
    const rows = await this.prisma.$queryRaw<PagoTarjetaRow[]>`
      SELECT cc.tarjeta AS tarjeta, cd.fecha_pago AS fecha_pago, SUM(cd.pago_total) AS valor_pago
      FROM "CuotasDetalle" cd
      JOIN "ComprasCredito" cc ON cd.compra = cc.id
      WHERE cd.estado != 'Ajuste Interes'
        AND cc.owner_user_id = ${ownerUserId}::int8
      GROUP BY cc.tarjeta, cd.fecha_pago
      ORDER BY cd.fecha_pago, cc.tarjeta`;
    return rows.map((r) => ({
      valorPago: num(r.valor_pago),
      tarjeta: idNum(r.tarjeta),
      fechaPago: dateToMillis(r.fecha_pago),
    }));
  }

  /** `GET /api/tarjetas/pagos/:id?mes&year` — cuotas del mes de una tarjeta (`CuotaDetalleMes`). */
  async calcularPagoTarjetaCreditoDetalle(tarjetaId: number, year: number, mes: number, ownerUserId: bigint) {
    const rows = await this.prisma.$queryRaw<CuotaMesRow[]>`
      SELECT cd.id, cc.concepto, cd.numero_cuota, cc.numero_cuotas, cd.fecha_pago, cd.saldo_restante,
             cd.interes_pagado, cd.aporte_capital, cd.pago_total, cd.compra, cd.estado, cc.tarjeta
      FROM "CuotasDetalle" cd
      JOIN "ComprasCredito" cc ON cd.compra = cc.id
      WHERE cd.estado != 'Ajuste Interes'
        AND DATE_TRUNC('month', cd.fecha_pago) = DATE_TRUNC('month', make_date(${year}::int, ${mes}::int, 1))
        AND cc.tarjeta = ${BigInt(tarjetaId)}::int8
        AND cc.owner_user_id = ${ownerUserId}::int8
      ORDER BY cd.fecha_pago, cd.compra, cd.numero_cuota`;
    return rows.map((r) => ({
      id: idNum(r.id),
      numeroCuota: idNum(r.numero_cuota),
      fechaPago: dateToMillis(r.fecha_pago),
      saldoRestante: num(r.saldo_restante),
      interesPagado: num(r.interes_pagado),
      aporteCapital: num(r.aporte_capital),
      pagoTotal: num(r.pago_total),
      compra: idNum(r.compra),
      estado: r.estado,
      tarjeta: idNum(r.tarjeta),
      concepto: r.concepto,
      numeroCuotasTotal: r.numero_cuotas ?? 0,
    }));
  }

  /** `POST /api/compras-credito/pagar-productos`: pendientes con última cuota <= hoy pasan a 'Pagado'. */
  async pagarProductosTarjetaCredito(ownerUserId: bigint, hoy: Date = todayLocal()): Promise<number> {
    const resultado = await this.prisma.comprasCredito.updateMany({
      where: {
        owner_user_id: ownerUserId,
        estado: { equals: 'PENDIENTE', mode: 'insensitive' },
        fecha_ultima_cuota: { lte: hoy },
      },
      data: { estado: 'Pagado' },
    });
    return resultado.count;
  }
}
