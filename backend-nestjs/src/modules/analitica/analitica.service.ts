import { Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '../../config/decimal.config';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { inferirComercioYTags } from '../notificaciones-correo/comercio.util';
import { parsearConsulta } from './consulta-lenguaje.util';
import { TaggingEngineService } from './tagging-engine.service';

export interface FilaAnalitica {
  tipo: 'COMPRA_TC' | 'TRANSACCION';
  id: number;
  fecha: string | null;
  descripcion: string;
  comercioCanonico: string | null;
  tags: string[];
  monto: Decimal;
}

/** Agregación pura (testeable): total, conteo, promedio y desglose por comercio canónico. */
export function agregarFilas(filas: FilaAnalitica[]) {
  const total = filas.reduce((acc, f) => acc.plus(f.monto), new Decimal(0));
  const porComercio = new Map<string, { total: Decimal; operaciones: number }>();
  for (const f of filas) {
    const clave = f.comercioCanonico ?? f.descripcion ?? 'Sin comercio';
    const g = porComercio.get(clave) ?? { total: new Decimal(0), operaciones: 0 };
    g.total = g.total.plus(f.monto);
    g.operaciones += 1;
    porComercio.set(clave, g);
  }
  return {
    total: money(total),
    operaciones: filas.length,
    promedio: filas.length > 0 ? money(total.div(filas.length)) : money(new Decimal(0)),
    desglose: [...porComercio.entries()]
      .map(([clave, g]) => ({ clave, total: money(g.total), operaciones: g.operaciones }))
      .sort((a, b) => b.total.comparedTo(a.total)),
  };
}

@Injectable()
export class AnaliticaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagging: TaggingEngineService,
  ) {}

  retag(ownerUserId: bigint, soloSinTags?: boolean) {
    return this.tagging.retagHistorico(ownerUserId, { soloSinTags });
  }

  async consulta(ownerUserId: bigint, q: string, desde?: string, hasta?: string) {
    const parseada = parsearConsulta(q);
    const fDesde = desde ? new Date(`${desde}T00:00:00Z`) : parseada.desde;
    const fHasta = hasta ? new Date(`${hasta}T23:59:59Z`) : parseada.hasta;
    if ((desde && Number.isNaN(fDesde?.getTime())) || (hasta && Number.isNaN(fHasta?.getTime()))) {
      throw datosInvalidos({ periodo: ['desde/hasta deben tener formato yyyy-MM-dd'] });
    }
    const filas = await this.buscarFilas(ownerUserId, parseada.tags, parseada.comercios, fDesde, fHasta);
    const agg = agregarFilas(filas);
    return {
      pregunta: q,
      interpretacion: { tags: parseada.tags, comercios: parseada.comercios, periodo: parseada.textoPeriodo },
      desde: fDesde?.toISOString().slice(0, 10) ?? null,
      hasta: fHasta?.toISOString().slice(0, 10) ?? null,
      ...agg,
      detalle: filas.slice(0, 100).map((f) => ({ tipo: f.tipo, id: f.id, fecha: f.fecha, descripcion: f.descripcion, comercioCanonico: f.comercioCanonico, tags: f.tags, monto: money(f.monto) })),
    };
  }

  private async buscarFilas(ownerUserId: bigint, tags: string[], comercios: string[], desde: Date | null, hasta: Date | null): Promise<FilaAnalitica[]> {
    const filtroTags = tags.length > 0 ? { tags: { hasSome: tags } } : {};
    const filtroComercio = comercios.length > 0 ? { comercio_canonico: { in: comercios } } : {};
    // Sin tags ni comercios no hay criterio: no se devuelve todo el historial por accidente.
    if (tags.length === 0 && comercios.length === 0) return [];
    const [compras, transacciones] = await Promise.all([
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId, OR: [{ ...filtroTags }, ...(comercios.length ? [{ ...filtroComercio }] : [])], ...(desde || hasta ? { fecha_compra: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } } : {}) },
        orderBy: { fecha_compra: 'desc' },
        take: 5000,
      }),
      this.prisma.transacciones.findMany({
        // EGRESO directo; PAGO_TARJETA se excluye para no duplicar las compras TC subyacentes.
        where: { owner_user_id: ownerUserId, tipo_transaccion: 'EGRESO', estado: { not: 'ANULADO' }, OR: [{ ...filtroTags }, ...(comercios.length ? [{ ...filtroComercio }] : [])], ...(desde || hasta ? { fecha_transaccion: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } } : {}) },
        orderBy: { fecha_transaccion: 'desc' },
        take: 5000,
      }),
    ]);
    // hasSome + comercio en OR puede traer filas que solo cumplen un criterio cuando hay ambos:
    // se exige que cumpla tags (si se pidieron) O comercio (si se pidió), que es la semántica de «Rappi y Didi».
    return [
      ...compras.map((c): FilaAnalitica => ({ tipo: 'COMPRA_TC', id: idNum(c.id), fecha: c.fecha_compra?.toISOString().slice(0, 10) ?? null, descripcion: c.concepto ?? '', comercioCanonico: c.comercio_canonico, tags: c.tags, monto: toDecimal(c.valor_compra) })),
      ...transacciones.map((t): FilaAnalitica => ({ tipo: 'TRANSACCION', id: idNum(t.id), fecha: t.fecha_transaccion?.toISOString().slice(0, 10) ?? null, descripcion: t.concepto ?? '', comercioCanonico: t.comercio_canonico, tags: t.tags, monto: toDecimal(t.monto_cop) })),
    ].sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? ''));
  }

  async listarTags(ownerUserId: bigint) {
    return this.prisma.etiquetas.findMany({ where: { owner_user_id: ownerUserId }, orderBy: { slug: 'asc' } });
  }

  /** Edición de tags de una fila + aprendizaje en caliente (crear regla para ese comercio). */
  async actualizarTags(ownerUserId: bigint, dto: { tipo: 'COMPRA' | 'TRANSACCION'; id: number; tags: string[]; crearRegla?: boolean }) {
    const tags = [...new Set(dto.tags.map((t) => (t.startsWith('#') ? t : `#${t}`).toLowerCase()))];
    let descripcion = '';
    if (dto.tipo === 'COMPRA') {
      const c = await this.prisma.comprasCredito.findFirst({ where: { id: BigInt(dto.id), owner_user_id: ownerUserId } });
      if (!c) throw new NotFoundException(`Compra ${dto.id} no encontrada`);
      descripcion = c.concepto ?? '';
      await this.prisma.comprasCredito.update({ where: { id: c.id }, data: { tags } });
    } else {
      const t = await this.prisma.transacciones.findFirst({ where: { id: BigInt(dto.id), owner_user_id: ownerUserId } });
      if (!t) throw new NotFoundException(`Transacción ${dto.id} no encontrada`);
      descripcion = t.concepto ?? '';
      await this.prisma.transacciones.update({ where: { id: t.id }, data: { tags } });
    }
    let reglaCreada = false;
    if (dto.crearRegla && descripcion) {
      const inferido = inferirComercioYTags(descripcion);
      const patron = descripcion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200);
      await this.prisma.reglasAutoTag.create({
        data: { owner_user_id: ownerUserId, patron_comercio_regex: patron, comercio_canonico: inferido.comercioCanonico, tags_slugs: tags, prioridad: 10 },
      });
      reglaCreada = true;
      // Re-tag retroactivo de ese comercio.
      await this.tagging.retagHistorico(ownerUserId);
    }
    return { tipo: dto.tipo, id: dto.id, tags, reglaCreada };
  }
}
