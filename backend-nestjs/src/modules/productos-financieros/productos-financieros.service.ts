import { Injectable } from '@nestjs/common';
import { formatIsoDate, todayLocal } from '../../common/utils/date.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoTarjeta } from '../tarjetas/tipos-tarjeta.util';
import { LineaTiempo, SIN_USO, Uso, claveAviso, construirLineaTiempo } from './linea-tiempo.util';

interface FilaUso {
  clave: bigint | string | null;
  n: bigint;
  monto: { toString(): string } | number | null;
  primera: Date | string | null;
  ultima: Date | string | null;
}

const dia = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : formatIsoDate(d));

const aUso = (f: FilaUso): Uso => ({ n: Number(f.n), monto: f.monto === null ? 0 : Number(f.monto.toString()), primera: dia(f.primera), ultima: dia(f.ultima) });

/**
 * Línea de tiempo de los productos financieros: cuándo se usó cada tarjeta (por plástico) y cada cuenta, y cuánto movimiento tuvo.
 * Solo lectura. Los movimientos salen de las compras a crédito, las transacciones y los avisos del banco (correos).
 */
@Injectable()
export class ProductosFinancierosService {
  constructor(private readonly prisma: PrismaService) {}

  async lineaTiempo(ownerUserId: bigint, ahora: Date = new Date()): Promise<LineaTiempo> {
    const [plasticos, lineasGenericas, cuentas, comprasPlastico, comprasLinea, avisos, transacciones] = await Promise.all([
      this.prisma.tarjetaPlasticos.findMany({
        where: { tarjeta: { owner_user_id: ownerUserId } },
        select: {
          id: true,
          tarjeta_id: true,
          ultimos_4: true,
          es_activo: true,
          vigente_desde: true,
          vigente_hasta: true,
          reemplaza_a_id: true,
          tarjeta: { select: { tipo_tarjeta: true, franquicia: true, alias: true, cuenta_id: true } },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.tarjetas.findMany({
        where: { owner_user_id: ownerUserId, es_generica: true, tipo_tarjeta: 'CREDITO', plasticos: { none: {} } },
        select: { id: true, franquicia: true, alias: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, nombre: true, banco_entidad: true, ultimos_4_digitos: true, is_active: true, es_generica: true, fecha_inicio_uso: true, fecha_fin_uso: true },
        orderBy: { id: 'asc' },
      }),
      // Compras a crédito por plástico: el guardado en la compra o, si no lo tiene, el vigente en su fecha (la misma regla que el historial).
      this.prisma.$queryRaw<FilaUso[]>`
        SELECT COALESCE(c.plastico_id, p.id) AS clave, COUNT(*) AS n, SUM(c.valor_compra) AS monto,
               MIN(c.fecha_compra) AS primera, MAX(c.fecha_compra) AS ultima
          FROM "ComprasCredito" c
          LEFT JOIN LATERAL (
            SELECT x.id FROM "TarjetaPlasticos" x
             WHERE c.plastico_id IS NULL AND x.tarjeta_id = c.tarjeta
             ORDER BY CASE WHEN x.vigente_desde IS NULL OR x.vigente_desde <= c.fecha_compra THEN 0 ELSE 1 END,
                      CASE WHEN x.vigente_desde IS NULL OR x.vigente_desde <= c.fecha_compra THEN x.vigente_desde END DESC NULLS LAST,
                      x.vigente_desde ASC NULLS FIRST, x.id DESC
             LIMIT 1
          ) p ON true
         WHERE c.owner_user_id = ${ownerUserId}::int8
         GROUP BY 1`,
      this.prisma.$queryRaw<FilaUso[]>`
        SELECT c.tarjeta AS clave, COUNT(*) AS n, SUM(c.valor_compra) AS monto, MIN(c.fecha_compra) AS primera, MAX(c.fecha_compra) AS ultima
          FROM "ComprasCredito" c
         WHERE c.owner_user_id = ${ownerUserId}::int8 AND NOT EXISTS (SELECT 1 FROM "TarjetaPlasticos" x WHERE x.tarjeta_id = c.tarjeta)
         GROUP BY 1`,
      // Avisos del banco: por últimos 4 y tipo de producto; sin números = producto «sin número». Los duplicados no cuentan.
      this.prisma.$queryRaw<Array<FilaUso & { ultimos_4: string | null; instrumento: string }>>`
        SELECT n.ultimos_4 AS ultimos_4,
               CASE WHEN UPPER(COALESCE(n.datos_parseados->>'instrumento', '')) = 'TC' THEN 'TC' ELSE 'CUENTA' END AS instrumento,
               NULL::text AS clave, COUNT(*) AS n,
               COALESCE(SUM(CASE WHEN COALESCE(n.moneda, 'COP') = 'COP' THEN n.monto_original END), 0) AS monto,
               MIN((n.fecha_correo AT TIME ZONE 'America/Bogota')::date) AS primera,
               MAX((n.fecha_correo AT TIME ZONE 'America/Bogota')::date) AS ultima
          FROM "NotificacionesCorreo" n
         WHERE n.owner_user_id = ${ownerUserId}::int8 AND COALESCE(n.vinculo, '') <> 'DUPLICADO'
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<FilaUso[]>`
        SELECT x.cuenta_id AS clave, COUNT(*) AS n, SUM(x.monto_cop) AS monto, MIN(x.d) AS primera, MAX(x.d) AS ultima
          FROM (
            SELECT cuenta_origen_id AS cuenta_id, monto_cop, (fecha_transaccion AT TIME ZONE 'America/Bogota')::date AS d
              FROM "Transacciones" WHERE owner_user_id = ${ownerUserId}::int8 AND estado IS DISTINCT FROM 'ANULADO' AND cuenta_origen_id IS NOT NULL
            UNION ALL
            SELECT cuenta_destino_id, monto_cop, (fecha_transaccion AT TIME ZONE 'America/Bogota')::date
              FROM "Transacciones" WHERE owner_user_id = ${ownerUserId}::int8 AND estado IS DISTINCT FROM 'ANULADO' AND cuenta_destino_id IS NOT NULL
          ) x
         GROUP BY 1`,
    ]);

    const porClave = (filas: FilaUso[]) => new Map(filas.map((f) => [Number(f.clave), aUso(f)] as const));
    const mapaAvisos = new Map<string, Uso>();
    for (const f of avisos) {
      const k = claveAviso(f.ultimos_4, f.instrumento === 'TC' ? 'TC' : 'CUENTA');
      const nuevo = aUso(f);
      const previo = mapaAvisos.get(k) ?? SIN_USO;
      mapaAvisos.set(k, { n: previo.n + nuevo.n, monto: previo.monto + nuevo.monto, primera: [previo.primera, nuevo.primera].filter(Boolean).sort()[0] ?? null, ultima: [previo.ultima, nuevo.ultima].filter(Boolean).sort().reverse()[0] ?? null });
    }

    return construirLineaTiempo({
      plasticos: plasticos.map((p) => ({
        id: idNum(p.id),
        tarjetaId: idNum(p.tarjeta_id),
        ultimos4: p.ultimos_4,
        esActivo: p.es_activo,
        vigenteDesde: dia(p.vigente_desde),
        vigenteHasta: dia(p.vigente_hasta),
        reemplazaAId: p.reemplaza_a_id === null ? null : idNum(p.reemplaza_a_id),
        tipo: p.tarjeta.tipo_tarjeta as TipoTarjeta,
        franquicia: p.tarjeta.franquicia,
        alias: p.tarjeta.alias,
        cuentaId: p.tarjeta.cuenta_id === null ? null : idNum(p.tarjeta.cuenta_id),
      })),
      lineasGenericas: lineasGenericas.map((l) => ({ id: idNum(l.id), franquicia: l.franquicia, alias: l.alias })),
      cuentas: cuentas.map((c) => ({
        id: idNum(c.id),
        nombre: c.nombre,
        bancoEntidad: c.banco_entidad,
        ultimos4: c.ultimos_4_digitos,
        activa: c.is_active !== false,
        esGenerica: c.es_generica,
        inicioUso: dia(c.fecha_inicio_uso),
        finUso: dia(c.fecha_fin_uso),
      })),
      usos: { comprasPorPlastico: porClave(comprasPlastico), comprasPorLinea: porClave(comprasLinea), avisos: mapaAvisos, transaccionesPorCuenta: porClave(transacciones) },
      hoy: formatIsoDate(todayLocal(ahora)),
    });
  }
}
