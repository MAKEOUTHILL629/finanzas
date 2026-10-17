import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { periodoActual } from '../../common/utils/date.util';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';

/** Persona «yo» según los triggers de la BD (enlazada al usuario o la del AppSheet original). */
const LEGACY_YO = 'lm1R40P16oHgkM3Szu91du';

/** Una cuota de una compra con tarjeta que le toca a un TERCERO (porcentaje del responsable × cuota). */
export interface CuotaTercero {
  personaId: bigint;
  compraId: bigint;
  concepto: string | null;
  fechaCompra: Date | null;
  valorCompra: Decimal;
  numeroCuotasCompra: number;
  tarjetaId: bigint | null;
  tarjeta: string | null;
  plasticoUltimos4: string | null;
  responsableId: bigint;
  porcentaje: Decimal;
  /** Cuántas cuotas le tocan a la persona (las primeras N); `null` = todas. */
  cuotasDeLaPersona: number | null;
  cuotaId: bigint;
  numeroCuota: number;
  periodo: string;
  fechaPago: Date;
  pagoTotal: Decimal;
  /** `pagoTotal × porcentaje / 100`, redondeado a centavos (igual que el Trigger 6). */
  monto: Decimal;
  /** Asiento `CARGO_CUOTA_TC` del sub-ledger de esta cuota y responsable, si ya existe (no anulado). */
  movimientoId: bigint | null;
  movimientoEstado: string | null;
}

interface FilaBd {
  persona_id: bigint;
  compra_id: bigint;
  concepto: string | null;
  fecha_compra: Date | null;
  valor_compra: Prisma.Decimal | null;
  numero_cuotas: number | null;
  tarjeta_id: bigint | null;
  franquicia: string | null;
  descripcion_tarjeta: string | null;
  plastico_ultimos4: string | null;
  responsable_id: bigint;
  porcentaje_pago: Prisma.Decimal | null;
  cantidad_cuotas: number | null;
  cuota_id: bigint;
  numero_cuota: bigint | number | null;
  periodo: string;
  fecha_pago: Date;
  pago_total: Prisma.Decimal | null;
  monto: Prisma.Decimal;
  mov_id: bigint | null;
  mov_estado: string | null;
}

/**
 * Estado que el Trigger 6 le daría al asiento de una cuota: la primera cuota o una ya facturada (periodo ≤ hoy) es firme
 * (`CONFIRMADO`); las futuras son una proyección (`PROYECTADO`).
 */
export function estadoDeCuota(numeroCuota: number, periodo: string, hoy: string = periodoActual()): 'CONFIRMADO' | 'PROYECTADO' {
  return numeroCuota === 1 || periodo <= hoy ? 'CONFIRMADO' : 'PROYECTADO';
}

/**
 * Cuotas de tarjeta que cada TERCERO debe, calculadas desde las tablas de compras (`ResponsablesComprasCredito` × `CuotasDetalle`).
 *
 * Es la fuente de verdad de «qué le toca a cada persona de lo que compré con mi tarjeta»: no depende de que el sub-ledger
 * (`MovimientosDeudaPersona`) tenga ya el asiento de cada cuota (las compras anteriores a los triggers no lo tienen) y, como se
 * calcula al leer, cualquier alta, edición o borrado de una compra o de sus responsables se refleja al instante.
 * Cada fila dice además si esa cuota ya tiene su asiento en el sub-ledger, para no contarla dos veces.
 */
@Injectable()
export class CuotasTercerosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(ownerUserId: bigint, filtro: { personaId?: number } = {}): Promise<CuotaTercero[]> {
    const porPersona = filtro.personaId !== undefined ? Prisma.sql`AND rcc.persona = ${BigInt(filtro.personaId)}::int8` : Prisma.empty;
    const filas = await this.prisma.$queryRaw<FilaBd[]>(Prisma.sql`
      SELECT rcc.persona AS persona_id,
             cc.id AS compra_id, cc.concepto, cc.fecha_compra, cc.valor_compra, cc.numero_cuotas,
             cc.tarjeta AS tarjeta_id, t.franquicia, t.descripcion AS descripcion_tarjeta, pl.ultimos_4 AS plastico_ultimos4,
             rcc.id AS responsable_id, rcc.porcentaje_pago, rcc.cantidad_cuotas,
             cd.id AS cuota_id, cd.numero_cuota,
             COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) AS periodo,
             cd.fecha_pago, cd.pago_total,
             ROUND((cd.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2) AS monto,
             m.id AS mov_id, m.estado AS mov_estado
      FROM "ResponsablesComprasCredito" rcc
      JOIN "ComprasCredito" cc ON cc.id = rcc.compra_credito AND cc.owner_user_id = ${ownerUserId}::int8
      JOIN "CuotasDetalle" cd ON cd.compra = cc.id AND cd.fecha_pago IS NOT NULL
        AND (rcc.cantidad_cuotas IS NULL OR cd.numero_cuota <= rcc.cantidad_cuotas)
      LEFT JOIN "Tarjetas" t ON t.id = cc.tarjeta
      LEFT JOIN "TarjetaPlasticos" pl ON pl.id = cc.plastico_id
      LEFT JOIN LATERAL (
        SELECT id, estado FROM "MovimientosDeudaPersona" mm
        WHERE mm.cuota_detalle_id = cd.id AND mm.responsable_compra_id = rcc.id AND COALESCE(mm.estado, 'CONFIRMADO') <> 'ANULADO'
        ORDER BY mm.id DESC LIMIT 1
      ) m ON true
      WHERE rcc.persona IS NOT NULL
        AND rcc.persona IS DISTINCT FROM (
          SELECT p.id FROM "Personas" p WHERE p.linked_user_id = ${ownerUserId}::int8 OR p.legacy_appsheet_id = ${LEGACY_YO} ORDER BY p.id LIMIT 1
        )
        AND ROUND((cd.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2) > 0
        AND COALESCE(cc.concepto, '') NOT ILIKE '%ajuste de interes%'
        AND UPPER(COALESCE(cd.estado, '')) <> 'REFINANCIADA' -- lo unificado se debe por la obligación nueva
        ${porPersona}
      ORDER BY rcc.persona, COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')), cc.id, cd.numero_cuota`);

    return filas.map((f) => ({
      personaId: f.persona_id,
      compraId: f.compra_id,
      concepto: f.concepto,
      fechaCompra: f.fecha_compra,
      valorCompra: money(toDecimal(f.valor_compra)),
      numeroCuotasCompra: f.numero_cuotas ?? 1,
      tarjetaId: f.tarjeta_id,
      tarjeta: [f.franquicia, f.descripcion_tarjeta].filter(Boolean).join(' · ') || (f.tarjeta_id === null ? null : `Tarjeta #${f.tarjeta_id}`),
      plasticoUltimos4: f.plastico_ultimos4,
      responsableId: f.responsable_id,
      porcentaje: toDecimal(f.porcentaje_pago),
      cuotasDeLaPersona: f.cantidad_cuotas,
      cuotaId: f.cuota_id,
      numeroCuota: Number(f.numero_cuota ?? 1),
      periodo: f.periodo,
      fechaPago: f.fecha_pago,
      pagoTotal: money(toDecimal(f.pago_total)),
      monto: money(toDecimal(f.monto)),
      movimientoId: f.mov_id,
      movimientoEstado: f.mov_estado,
    }));
  }
}
