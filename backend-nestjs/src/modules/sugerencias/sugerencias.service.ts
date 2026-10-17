import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ComercioHabitual, agruparComercios, ordenarPorUso, Uso } from './sugerencias.util';

/** Ventana con la que se mide «lo que más uso últimamente». */
export const DIAS_RECIENTES = 120;
const DIA_MS = 86_400_000;

/** Valores con los que los formularios arrancan (todos opcionales: `null` = no hay de dónde deducirlo). */
export interface DefaultsFormularios {
  /** Tarjeta de crédito con más compras en los últimos 120 días (o, sin compras, la vigente más nueva). */
  tarjetaCreditoId: number | null;
  /** Tarjeta de débito vigente (la de la cuenta más usada si hay varias). */
  tarjetaDebitoId: number | null;
  /** Cuenta en pesos con más egresos recientes; sin movimientos, la principal. */
  cuentaId: number | null;
  /** Cuotas con las que se abre una compra a crédito. */
  cuotas: number;
  /** La persona que usa la app (la enlazada a su usuario). */
  personaPropiaId: number | null;
  /** Quién puso aportes al carro, de más a menos frecuente (para ordenar el selector; no limita a nadie). */
  personaAporteIds: number[];
  /** Último responsable que se asignó a una compra a crédito. */
  ultimaPersonaCompraId: number | null;
  /** Quien puso el último aporte al carro. */
  ultimaPersonaAporteId: number | null;
}

const num = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class SugerenciasService {
  constructor(private readonly prisma: PrismaService) {}

  async formularios(ownerUserId: bigint, ahora: Date = new Date()): Promise<DefaultsFormularios> {
    const desde = new Date(ahora.getTime() - DIAS_RECIENTES * DIA_MS);
    const [tarjetas, cuentas, comprasRecientes, comprasTotales, egresosRecientes, propia, aportes, ultimaCompra] = await Promise.all([
      this.prisma.tarjetas.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, tipo_tarjeta: true, es_generica: true, cuenta_id: true, plasticos: { select: { es_activo: true, vigente_desde: true } } },
        orderBy: { id: 'asc' },
      }),
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, es_principal: true, moneda: true, is_active: true, es_generica: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.comprasCredito.groupBy({ by: ['tarjeta'], where: { owner_user_id: ownerUserId, tarjeta: { not: null }, fecha_compra: { gte: desde } }, _count: { _all: true }, _max: { fecha_compra: true } }),
      this.prisma.comprasCredito.groupBy({ by: ['tarjeta'], where: { owner_user_id: ownerUserId, tarjeta: { not: null } }, _count: { _all: true }, _max: { fecha_compra: true } }),
      this.prisma.transacciones.groupBy({
        by: ['cuenta_origen_id'],
        where: { owner_user_id: ownerUserId, tipo_transaccion: 'EGRESO', estado: { not: 'ANULADO' }, cuenta_origen_id: { not: null }, fecha_transaccion: { gte: desde } },
        _count: { _all: true },
        _max: { fecha_transaccion: true },
      }),
      this.prisma.personas.findFirst({ where: { owner_user_id: ownerUserId, linked_user_id: ownerUserId }, select: { id: true } }),
      this.prisma.$queryRaw<Array<{ persona_id: bigint; n: number; ultimo: bigint }>>`
        SELECT d.persona_id, count(*)::int AS n, max(d.id) AS ultimo
          FROM "AportesDetalle" d
          JOIN "AportesDia" a ON a.id = d.aporte_dia_id
          JOIN "ObligacionesMes" o ON o.id = a.obligacion_mes_id
         WHERE o.owner_user_id = ${ownerUserId}
         GROUP BY d.persona_id`,
      this.prisma.responsablesComprasCredito.findFirst({
        where: { persona: { not: null }, compra_credito_ref: { owner_user_id: ownerUserId } },
        orderBy: { id: 'desc' },
        select: { persona: true },
      }),
    ]);

    // ── tarjeta de crédito ──
    const credito = tarjetas.filter((t) => t.tipo_tarjeta !== 'DEBITO' && !t.es_generica);
    const idsCredito = new Set(credito.map((t) => Number(t.id)));
    const usos = (filas: Array<{ tarjeta: bigint | null; _count: { _all: number }; _max: { fecha_compra: Date | null } }>): Uso<number>[] =>
      filas.filter((f) => f.tarjeta !== null && idsCredito.has(Number(f.tarjeta))).map((f) => ({ id: Number(f.tarjeta), n: f._count._all, ultima: f._max.fecha_compra?.getTime() ?? 0 }));
    const porUso = ordenarPorUso(usos(comprasRecientes))[0] ?? ordenarPorUso(usos(comprasTotales))[0] ?? null;
    const vigenteDesde = (t: (typeof tarjetas)[number]): number => Math.max(0, ...t.plasticos.filter((p) => p.es_activo).map((p) => p.vigente_desde?.getTime() ?? 1));
    const masNuevaVigente = [...credito].filter((t) => t.plasticos.some((p) => p.es_activo)).sort((a, b) => vigenteDesde(b) - vigenteDesde(a))[0];
    const tarjetaCreditoId = porUso ?? num(masNuevaVigente?.id) ?? num(credito[0]?.id);

    // ── cuenta ──
    const cuentasUsables = cuentas.filter((c) => c.is_active !== false && c.moneda === 'COP' && !c.es_generica);
    const idsCuentas = new Set(cuentasUsables.map((c) => Number(c.id)));
    const usoCuentas: Uso<number>[] = egresosRecientes
      .filter((f) => f.cuenta_origen_id !== null && idsCuentas.has(Number(f.cuenta_origen_id)))
      .map((f) => ({ id: Number(f.cuenta_origen_id), n: f._count._all, ultima: f._max.fecha_transaccion?.getTime() ?? 0 }));
    const cuentaId = ordenarPorUso(usoCuentas)[0] ?? num(cuentasUsables.find((c) => c.es_principal)?.id) ?? num(cuentasUsables[0]?.id);

    // ── tarjeta de débito: con plástico vigente, preferiblemente de la cuenta elegida; si no, la más nueva ──
    const debitoVigente = tarjetas.filter((t) => t.tipo_tarjeta === 'DEBITO' && t.plasticos.some((p) => p.es_activo));
    const delaCuenta = debitoVigente.filter((t) => t.cuenta_id !== null && Number(t.cuenta_id) === cuentaId);
    const candidatas = delaCuenta.length > 0 ? delaCuenta : debitoVigente;
    const tarjetaDebitoId = num([...candidatas].sort((a, b) => vigenteDesde(b) - vigenteDesde(a))[0]?.id);

    const personaAporteIds = ordenarPorUso(aportes.map((a) => ({ id: Number(a.persona_id), n: a.n, ultima: Number(a.ultimo) })));
    const ultimoAporte = [...aportes].sort((a, b) => Number(b.ultimo) - Number(a.ultimo))[0];

    return {
      tarjetaCreditoId,
      tarjetaDebitoId,
      cuentaId,
      cuotas: 1,
      personaPropiaId: num(propia?.id),
      personaAporteIds,
      ultimaPersonaCompraId: num(ultimaCompra?.persona),
      ultimaPersonaAporteId: ultimoAporte ? Number(ultimoAporte.persona_id) : null,
    };
  }

  /** Comercios que ya usaste, con lo habitual de cada uno (cuotas, tarjeta, categoría, cuenta, responsable). */
  async comercios(ownerUserId: bigint, opciones: { q?: string; limit?: number } = {}): Promise<ComercioHabitual[]> {
    const [compras, movimientos] = await Promise.all([
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId, concepto: { not: null } },
        select: { concepto: true, numero_cuotas: true, tarjeta: true, fecha_compra: true, responsables: { select: { persona: true } } },
        orderBy: [{ fecha_compra: 'desc' }, { id: 'desc' }],
        take: 4000,
      }),
      this.prisma.transacciones.findMany({
        where: { owner_user_id: ownerUserId, tipo_transaccion: 'EGRESO', estado: { not: 'ANULADO' } },
        select: { concepto: true, categoria_id: true, cuenta_origen_id: true, fecha_transaccion: true },
        orderBy: [{ fecha_transaccion: 'desc' }, { id: 'desc' }],
        take: 4000,
      }),
    ]);
    return agruparComercios(
      compras.map((c) => ({
        concepto: c.concepto,
        numeroCuotas: c.numero_cuotas,
        tarjetaId: num(c.tarjeta),
        fecha: c.fecha_compra,
        personas: c.responsables.map((r) => num(r.persona)).filter((p): p is number => p !== null),
      })),
      movimientos.map((m) => ({ concepto: m.concepto, categoriaId: num(m.categoria_id), cuentaId: num(m.cuenta_origen_id), fecha: m.fecha_transaccion })),
      opciones.limit ?? 300,
      opciones.q,
    );
  }
}
