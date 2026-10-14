import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatMdy, idNum, num } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';

interface PagoPersonaRow {
  persona_id: bigint;
  mes_pago: Date;
  total_pago_responsable: Prisma.Decimal;
}

interface PagoPersonaDetalleRow {
  persona_id: bigint;
  compra_credito_id: bigint;
  concepto: string | null;
  porcentaje_pago: Prisma.Decimal | null;
  cantidad_cuotas: number | null;
  numero_cuota: bigint;
  fecha_pago: Date;
  pago_total: Prisma.Decimal;
  estado: string | null;
  tarjeta: bigint;
  saldo_restante: Prisma.Decimal;
  interes_pagado: Prisma.Decimal;
  aporte_capital: Prisma.Decimal;
  monto_a_pagar_responsable: Prisma.Decimal;
}

/**
 * Equivale a `ConsultaPagosMensuales.scala` + `ConsultasPagosControlador.scala`.
 * Los productos `pago_total * porcentaje / 100` se calculan en PostgreSQL con `numeric` (exacto).
 */
@Injectable()
export class ConsultasPagosService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /api/pagos/personas` — total mensual por persona (fecha en formato MM/dd/yyyy). */
  async listPagosMensualesPersona(ownerUserId: bigint) {
    const rows = await this.prisma.$queryRaw<PagoPersonaRow[]>`
      SELECT p.id AS persona_id,
             cd.fecha_pago AS mes_pago,
             SUM(cd.pago_total * (rc.porcentaje_pago / 100.0)) AS total_pago_responsable
      FROM "Personas" p
      INNER JOIN "ResponsablesComprasCredito" rc ON rc.persona = p.id
      INNER JOIN "ComprasCredito" cc ON cc.id = rc.compra_credito
      INNER JOIN "CuotasDetalle" cd ON cd.compra = cc.id
      WHERE cc.owner_user_id = ${ownerUserId}::int8
      GROUP BY p.id, p.nombre, cd.fecha_pago
      ORDER BY p.id, mes_pago`;
    return rows.map((r) => ({
      persona: idNum(r.persona_id),
      fecha: formatMdy(r.mes_pago),
      valorPago: num(r.total_pago_responsable),
    }));
  }

  /** `GET /api/pagos/personas/:id?mes&year` — detalle de cuotas del mes que le corresponden a un responsable. */
  async listPagosMensualesPersonaDetalle(personaId: number, mes: number, year: number, ownerUserId: bigint) {
    const rows = await this.prisma.$queryRaw<PagoPersonaDetalleRow[]>`
      SELECT p.id AS persona_id,
             cc.id AS compra_credito_id,
             cc.concepto,
             rc.porcentaje_pago,
             rc.cantidad_cuotas,
             cd.numero_cuota,
             cd.fecha_pago,
             cd.pago_total,
             cc.estado,
             cc.tarjeta,
             cd.saldo_restante * (rc.porcentaje_pago / 100.0) AS saldo_restante,
             cd.interes_pagado * (rc.porcentaje_pago / 100.0) AS interes_pagado,
             cd.aporte_capital * (rc.porcentaje_pago / 100.0) AS aporte_capital,
             cd.pago_total * (rc.porcentaje_pago / 100.0) AS monto_a_pagar_responsable
      FROM "Personas" p
      INNER JOIN "ResponsablesComprasCredito" rc ON rc.persona = p.id
      INNER JOIN "ComprasCredito" cc ON cc.id = rc.compra_credito
      INNER JOIN "CuotasDetalle" cd ON cd.compra = cc.id
      WHERE p.id = ${BigInt(personaId)}::int8
        AND cc.owner_user_id = ${ownerUserId}::int8
        AND DATE_TRUNC('month', cd.fecha_pago) = DATE_TRUNC('month', make_date(${year}::int, ${mes}::int, 1))
        AND cc.concepto NOT LIKE '%Ajuste de Interes%'
      ORDER BY p.id, cc.id, cd.fecha_pago`;
    return rows.map((r) => ({
      persona: idNum(r.persona_id),
      compraCredito: idNum(r.compra_credito_id),
      concepto: r.concepto,
      porcentaje: num(r.porcentaje_pago),
      cantidadCuotaTotal: r.cantidad_cuotas ?? 0,
      numeroCuota: idNum(r.numero_cuota),
      fechaPago: formatMdy(r.fecha_pago),
      valorPagoCuota: num(r.pago_total),
      valorPagoResponsable: num(r.monto_a_pagar_responsable),
      tarjeta: idNum(r.tarjeta),
      estado: r.estado,
      interesPagado: num(r.interes_pagado),
      aporteCapital: num(r.aporte_capital),
      saldoRestante: num(r.saldo_restante),
    }));
  }
}
