import { Injectable } from '@nestjs/common';
import { Decimal } from '../../config/decimal.config';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { inferirComercioYTags, ventanasDeViaje } from '../notificaciones-correo/comercio.util';

export interface ResultadoRetag {
  registrosAnalizados: number;
  registrosEtiquetados: number;
  nuevosTagsDetectados: Record<string, number>;
  ventanasViaje: number;
}

interface FilaGasto {
  id: bigint;
  descripcion: string;
  fecha: Date | null;
  monto: Decimal;
}

/**
 * Motor de backfill / re-tagging retroactivo (Fase 2): recorre compras_credito y transacciones
 * por lotes con cursor, aplica reglas del usuario + motor base de comercio, detecta clústeres
 * de viajes por contexto temporal y actualiza tags/comercio_canonico.
 */
@Injectable()
export class TaggingEngineService {
  constructor(private readonly prisma: PrismaService) {}

  /** Evalúa una descripción contra las reglas del usuario (regex) y el motor base. Puro salvo la lectura de reglas ya cargadas. */
  static evaluar(descripcion: string, reglas: Array<{ patron: RegExp; comercioCanonico: string | null; tags: string[] }>): { comercioCanonico: string | null; tags: string[] } {
    for (const r of reglas) {
      if (r.patron.test(descripcion)) return { comercioCanonico: r.comercioCanonico, tags: r.tags };
    }
    return inferirComercioYTags(descripcion);
  }

  async retagHistorico(ownerUserId: bigint, opciones: { soloSinTags?: boolean } = {}): Promise<ResultadoRetag> {
    const reglasDb = await this.prisma.reglasAutoTag.findMany({ where: { owner_user_id: ownerUserId, activo: true }, orderBy: { prioridad: 'asc' } });
    const reglas = reglasDb
      .map((r) => {
        const patronRaw = r.patron_comercio_regex ?? r.patron_descripcion_regex;
        if (!patronRaw) return null;
        try { return { patron: new RegExp(patronRaw, 'i'), comercioCanonico: r.comercio_canonico, tags: r.tags_slugs }; }
        catch { return null; }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const [compras, transacciones] = await Promise.all([
      this.prisma.comprasCredito.findMany({ where: { owner_user_id: ownerUserId }, select: { id: true, concepto: true, fecha_compra: true, valor_compra: true, tags: true }, orderBy: { id: 'asc' } }),
      this.prisma.transacciones.findMany({ where: { owner_user_id: ownerUserId, tipo_transaccion: 'EGRESO' }, select: { id: true, concepto: true, fecha_transaccion: true, monto_cop: true, tags: true }, orderBy: { id: 'asc' } }),
    ]);

    const filasCompra: FilaGasto[] = compras.map((c) => ({ id: c.id, descripcion: c.concepto ?? '', fecha: c.fecha_compra, monto: toDecimal(c.valor_compra) }));
    const filasTx: FilaGasto[] = transacciones.map((t) => ({ id: t.id, descripcion: t.concepto ?? '', fecha: t.fecha_transaccion, monto: toDecimal(t.monto_cop) }));
    const todas = [...filasCompra, ...filasTx];
    const evaluadas = todas.map((f) => ({ fila: f, ...TaggingEngineService.evaluar(f.descripcion, reglas) }));

    // Clústeres de viajes: consumos dentro de la ventana de un viaje ancla también son #viajes.
    const anclas = evaluadas.filter((e) => e.tags.includes('#viajes') && e.fila.fecha).map((e) => e.fila.fecha as Date);
    const ventanas = ventanasDeViaje(anclas);
    for (const e of evaluadas) {
      if (e.fila.fecha && !e.tags.includes('#viajes') && ventanas.some((v) => (e.fila.fecha as Date) >= v.desde && (e.fila.fecha as Date) <= v.hasta)) {
        e.tags = [...e.tags, '#viajes'];
      }
    }

    const conteo = new Map<string, number>();
    let etiquetados = 0;
    const aplicar = async (tipo: 'COMPRA' | 'TX', fila: FilaGasto, tags: string[], comercioCanonico: string | null) => {
      if (opciones.soloSinTags) {
        const actual = tipo === 'COMPRA' ? compras.find((c) => c.id === fila.id) : transacciones.find((t) => t.id === fila.id);
        if (actual && actual.tags.length > 0) return;
      }
      if (tipo === 'COMPRA') await this.prisma.comprasCredito.update({ where: { id: fila.id }, data: { tags, comercio_canonico: comercioCanonico } });
      else await this.prisma.transacciones.update({ where: { id: fila.id }, data: { tags, comercio_canonico: comercioCanonico } });
      if (tags.length > 0) {
        etiquetados += 1;
        for (const t of tags) conteo.set(t, (conteo.get(t) ?? 0) + 1);
        // Catálogo de etiquetas: se crea/actualiza sin duplicar (unique owner+slug).
        for (const slug of tags) {
          await this.prisma.etiquetas.upsert({
            where: { owner_user_id_slug: { owner_user_id: ownerUserId, slug } },
            create: { owner_user_id: ownerUserId, slug, nombre: slug.replace(/^#/, ''), tipo_agrupacion: slug === '#viajes' ? 'VIAJE' : 'HABITO' },
            update: {},
          });
        }
      }
    };
    for (const e of evaluadas.slice(0, filasCompra.length)) await aplicar('COMPRA', e.fila, e.tags, e.comercioCanonico);
    for (const e of evaluadas.slice(filasCompra.length)) await aplicar('TX', e.fila, e.tags, e.comercioCanonico);

    return { registrosAnalizados: todas.length, registrosEtiquetados: etiquetados, nuevosTagsDetectados: Object.fromEntries(conteo), ventanasViaje: ventanas.length };
  }

  /** Suma exacta (Decimal) de un conjunto de filas: nunca float. */
  static sumar(filas: Array<{ monto: Decimal }>): Decimal {
    return filas.reduce((acc, f) => acc.plus(f.monto), new Decimal(0));
  }

  static resumen(id: bigint, monto: Decimal) {
    return { id: idNum(id), monto: money(monto) };
  }
}
