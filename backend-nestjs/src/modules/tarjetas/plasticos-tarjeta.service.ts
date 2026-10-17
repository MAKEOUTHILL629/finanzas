import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TarjetaPlasticos } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { formatIsoDate, parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, sumDecimals, toDecimal } from '../../common/utils/decimal.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarPlasticoDto, AgregarPlasticoDto, ReemplazarPlasticoDto } from './dto/plasticos.dto';
import { aBase, ocupanteDeUltimos4, plasticosDeTarjeta, reemplazarPlastico, sincronizarCadena } from './plasticos.db';
import { MotivoReemplazo, PlasticoBase, plasticoParaFecha } from './plasticos.util';
import { EstadoPlastico, estadosDePlasticos } from './tipos-tarjeta.util';

export interface PlasticoJson {
  id: number;
  tarjetaId: number;
  ultimos4: string;
  esActivo: boolean;
  vigenteDesde: string | null;
  vigenteHasta: string | null;
  motivoReemplazo: string | null;
  reemplazaAId: number | null;
  notas: string | null;
  /** Compras que tienen este plástico guardado (las deducidas por fecha no cuentan). */
  compras?: number;
  /** ACTIVA · REEMPLAZADA (la línea siguió con otro plástico) · INACTIVA (histórico sin continuidad). Lo calcula `anotarPlasticos`. */
  estado?: EstadoPlastico;
  /** Alias de `vigenteDesde` / `vigenteHasta` / `reemplazaAId` con los nombres del plan de producto. */
  fechaInicioUso?: string | null;
  fechaFinUso?: string | null;
  tarjetaReemplazadaId?: number | null;
}

/** Añade el estado de cada plástico (según los demás de su línea) y los alias de fechas/reemplazo. Recibe los plásticos de UNA línea. */
export function anotarPlasticos(lista: PlasticoJson[]): PlasticoJson[] {
  const estados = estadosDePlasticos(lista);
  return lista.map((p) => ({
    ...p,
    estado: estados.get(p.id) ?? 'INACTIVA',
    fechaInicioUso: p.vigenteDesde,
    fechaFinUso: p.vigenteHasta,
    tarjetaReemplazadaId: p.reemplazaAId,
  }));
}

const fecha = (d: Date | null): string | null => (d ? formatIsoDate(d) : null);

export function plasticoJson(p: TarjetaPlasticos, compras?: number): PlasticoJson {
  return {
    id: idNum(p.id),
    tarjetaId: idNum(p.tarjeta_id),
    ultimos4: p.ultimos_4,
    esActivo: p.es_activo,
    vigenteDesde: fecha(p.vigente_desde),
    vigenteHasta: fecha(p.vigente_hasta),
    motivoReemplazo: p.motivo_reemplazo,
    reemplazaAId: p.reemplaza_a_id === null ? null : idNum(p.reemplaza_a_id),
    notas: p.notas,
    ...(compras !== undefined ? { compras } : {}),
  };
}

export interface FiltroHistorial {
  plasticoId?: number;
  desde?: string;
  hasta?: string;
  pagina?: number;
  limite?: number;
}

const LIMITE_DEFECTO = 200;
const LIMITE_MAXIMO = 1000;
const NO_PAGADA = `UPPER(COALESCE(cd.estado, '')) NOT IN ('PAGADO', 'PAGADA')`;

interface EstadisticaCuotas {
  compra: bigint;
  total: number;
  pendientes: number;
  saldo: Prisma.Decimal;
  proxima: Date | null;
}

/**
 * Plásticos de una tarjeta de crédito: lista, reemplazo (renovación/reposición) y el historial unificado de compras de la línea.
 * Las compras de todos los plásticos cuelgan de la misma `Tarjetas`; el plástico solo dice con cuál se pagó.
 */
@Injectable()
export class PlasticosTarjetaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(tarjetaId: number, ownerUserId: bigint): Promise<PlasticoJson[]> {
    await this.requireTarjeta(tarjetaId, ownerUserId);
    const filas = await this.prisma.tarjetaPlasticos.findMany({
      where: { tarjeta_id: BigInt(tarjetaId) },
      include: { _count: { select: { compras: true } } },
      orderBy: { id: 'asc' },
    });
    return anotarPlasticos(this.ordenar(filas.map((f) => plasticoJson(f, f._count.compras))));
  }

  /**
   * Registra un plástico HISTÓRICO (ya no vigente) o uno anterior que faltaba, sin tocar el plástico activo ni las compras.
   * Para un plástico nuevo que pasa a ser el vigente se usa `reemplazar`.
   */
  async agregarHistorico(tarjetaId: number, dto: AgregarPlasticoDto, ownerUserId: bigint) {
    const desde = dto.vigenteDesde ? this.fechaValida(dto.vigenteDesde, 'vigenteDesde') : null;
    const hasta = dto.vigenteHasta ? this.fechaValida(dto.vigenteHasta, 'vigenteHasta') : null;
    if (desde && hasta && desde.getTime() > hasta.getTime()) throw datosInvalidos({ vigenteHasta: ['La fecha de cierre no puede ser anterior al inicio'] });

    await this.prisma.$transaction(async (tx) => {
      const tarjeta = await tx.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId }, select: { id: true, owner_user_id: true } });
      if (!tarjeta) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
      const existentes = await plasticosDeTarjeta(tx, tarjeta.id);
      if (existentes.some((p) => p.ultimos_4 === dto.ultimos4)) {
        throw new HttpException({ message: `El plástico terminado en ${dto.ultimos4} ya está registrado en esta tarjeta` }, HttpStatus.CONFLICT);
      }
      const ocupante = await ocupanteDeUltimos4(tx, ownerUserId, dto.ultimos4, tarjeta.id);
      if (ocupante) throw new HttpException({ message: `Los dígitos ${dto.ultimos4} ya pertenecen a "${ocupante}"` }, HttpStatus.CONFLICT);
      await tx.tarjetaPlasticos.create({
        data: {
          tarjeta_id: tarjeta.id,
          owner_user_id: tarjeta.owner_user_id,
          ultimos_4: dto.ultimos4,
          // Sin ningún plástico registrado todavía, el que se agrega es el de la línea (activo salvo que traiga fecha de cierre).
          es_activo: existentes.length === 0 && !hasta,
          vigente_desde: desde,
          vigente_hasta: hasta,
          motivo_reemplazo: dto.motivo ?? null,
          notas: dto.notas?.trim() || null,
        },
      });
      await sincronizarCadena(tx, tarjeta.id);
    });
    return this.listar(tarjetaId, ownerUserId);
  }

  /** Archiva el plástico activo y registra el nuevo (o reactiva uno archivado con esos dígitos). El historial no se toca. */
  async reemplazar(tarjetaId: number, dto: ReemplazarPlasticoDto, ownerUserId: bigint) {
    const inicio = dto.vigenteDesde === undefined ? todayLocal() : parseIsoDate(dto.vigenteDesde);
    if (!inicio) throw datosInvalidos({ vigenteDesde: ['vigenteDesde debe tener formato yyyy-MM-dd'] });

    const { nuevo, anterior } = await this.prisma.$transaction(async (tx) => {
      const tarjeta = await tx.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId }, select: { id: true, owner_user_id: true } });
      if (!tarjeta) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
      return reemplazarPlastico(tx, tarjeta, { ultimos4: dto.ultimos4, inicio, motivo: dto.motivo ?? null, notas: dto.notas?.trim() || null });
    });

    return {
      plasticoActivo: plasticoJson(nuevo),
      plasticoAnterior: anterior ? plasticoJson(anterior) : null,
      plasticos: await this.listar(tarjetaId, ownerUserId),
    };
  }

  async actualizar(tarjetaId: number, plasticoId: number, dto: ActualizarPlasticoDto, ownerUserId: bigint) {
    if (dto.esActivo === false) {
      throw datosInvalidos({ esActivo: ['Un plástico se archiva registrando el reemplazo (POST …/plasticos/reemplazar)'] });
    }
    await this.prisma.$transaction(async (tx) => {
      const tarjeta = await tx.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId }, select: { id: true, owner_user_id: true } });
      if (!tarjeta) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
      const p = await tx.tarjetaPlasticos.findFirst({ where: { id: BigInt(plasticoId), tarjeta_id: tarjeta.id } });
      if (!p) throw new NotFoundException(`Plástico ${plasticoId} no encontrado`);

      const desde = dto.vigenteDesde === undefined ? p.vigente_desde : dto.vigenteDesde === null ? null : this.fechaValida(dto.vigenteDesde, 'vigenteDesde');
      const hasta = dto.vigenteHasta === undefined ? p.vigente_hasta : dto.vigenteHasta === null ? null : this.fechaValida(dto.vigenteHasta, 'vigenteHasta');
      if (desde && hasta && desde.getTime() > hasta.getTime()) throw datosInvalidos({ vigenteHasta: ['La fecha de cierre no puede ser anterior al inicio'] });

      if (dto.esActivo === true && !p.es_activo) {
        const motivo = dto.motivo !== undefined ? dto.motivo : (p.motivo_reemplazo as MotivoReemplazo | null);
        await reemplazarPlastico(tx, tarjeta, { ultimos4: p.ultimos_4, inicio: desde ?? todayLocal(), motivo, notas: dto.notas ?? null });
        return;
      }
      if (p.es_activo && hasta) throw datosInvalidos({ vigenteHasta: ['El plástico activo no puede tener fecha de cierre; registra el reemplazo'] });

      await tx.tarjetaPlasticos.update({
        where: { id: p.id },
        data: {
          vigente_desde: desde,
          vigente_hasta: hasta,
          ...(dto.motivo !== undefined ? { motivo_reemplazo: dto.motivo } : {}),
          ...(dto.notas !== undefined ? { notas: dto.notas?.trim() || null } : {}),
        },
      });
    });
    return this.listar(tarjetaId, ownerUserId);
  }

  /** Solo un plástico sin compras asociadas y que no sea el activo (salvo que sea el único). */
  async eliminar(tarjetaId: number, plasticoId: number, ownerUserId: bigint): Promise<PlasticoJson[]> {
    await this.prisma.$transaction(async (tx) => {
      const tarjeta = await tx.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId }, select: { id: true } });
      if (!tarjeta) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
      const p = await tx.tarjetaPlasticos.findFirst({ where: { id: BigInt(plasticoId), tarjeta_id: tarjeta.id }, include: { _count: { select: { compras: true } } } });
      if (!p) throw new NotFoundException(`Plástico ${plasticoId} no encontrado`);
      if (p._count.compras > 0) {
        throw new HttpException({ message: `El plástico tiene ${p._count.compras} compra(s) asociada(s); no se puede eliminar` }, HttpStatus.CONFLICT);
      }
      const total = await tx.tarjetaPlasticos.count({ where: { tarjeta_id: tarjeta.id } });
      if (p.es_activo && total > 1) {
        throw new HttpException({ message: 'Es el plástico activo: registra primero el reemplazo o activa otro' }, HttpStatus.CONFLICT);
      }
      await tx.tarjetaPlasticos.delete({ where: { id: p.id } });
      if (total === 1) await tx.tarjetas.update({ where: { id: tarjeta.id }, data: { ultimos_4_digitos: null } });
      else await sincronizarCadena(tx, tarjeta.id);
    });
    return this.listar(tarjetaId, ownerUserId);
  }

  // ───────────────────────────── historial unificado ─────────────────────────────

  /**
   * Todas las compras de la línea de crédito (de cualquier plástico), con el plástico de cada una: el guardado en la compra o,
   * si no lo tiene, el vigente en su fecha (`plasticoInferido`). Se puede filtrar por plástico y por rango de fechas.
   */
  async historial(tarjetaId: number, f: FiltroHistorial, ownerUserId: bigint) {
    const tarjeta = await this.requireTarjeta(tarjetaId, ownerUserId);
    const desde = f.desde ? this.fechaValida(f.desde, 'desde') : null;
    const hasta = f.hasta ? this.fechaValida(f.hasta, 'hasta') : null;
    const limite = Math.min(Math.max(f.limite ?? LIMITE_DEFECTO, 1), LIMITE_MAXIMO);
    const pagina = Math.max(f.pagina ?? 1, 1);

    const [plasticosDb, compras, estadisticas] = await Promise.all([
      plasticosDeTarjeta(this.prisma, tarjeta.id),
      this.prisma.comprasCredito.findMany({
        where: {
          tarjeta: tarjeta.id,
          owner_user_id: ownerUserId,
          ...(desde || hasta ? { fecha_compra: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } } : {}),
        },
        include: { responsables: { select: { persona: true, porcentaje_pago: true, cantidad_cuotas: true, persona_ref: { select: { nombre: true } } }, orderBy: { id: 'asc' } } },
        orderBy: [{ fecha_compra: 'desc' }, { id: 'desc' }],
      }),
      this.estadisticasCuotas(tarjeta.id, ownerUserId),
    ]);

    const plasticos = plasticosDb.map(aBase);
    const porId = new Map(plasticosDb.map((p) => [p.id, p]));
    const filas = compras.map((c) => {
      const guardado = c.plastico_id !== null ? porId.get(c.plastico_id) ?? null : null;
      const deducido = guardado ? null : plasticoParaFecha<PlasticoBase>(plasticos, c.fecha_compra);
      const plastico = guardado ?? (deducido ? porId.get(BigInt(deducido.plastico.id)) ?? null : null);
      return { compra: c, plastico, inferido: !guardado && plastico !== null };
    });

    const filtradas = f.plasticoId === undefined ? filas : filas.filter((x) => x.plastico !== null && Number(x.plastico.id) === f.plasticoId);
    const stats = new Map(estadisticas.map((e) => [e.compra, e]));

    const totales = {
      compras: filtradas.length,
      valorCompras: money(sumDecimals(filtradas.map((x) => x.compra.valor_compra))),
      saldoPendiente: money(sumDecimals(filtradas.map((x) => stats.get(x.compra.id)?.saldo ?? 0))),
    };

    const resumen = new Map<string, { plastico: TarjetaPlasticos | null; compras: number; valor: Decimal; inferidas: number }>();
    for (const x of filas) {
      const clave = x.plastico ? String(x.plastico.id) : 'sin';
      const r = resumen.get(clave) ?? { plastico: x.plastico, compras: 0, valor: new Decimal(0), inferidas: 0 };
      r.compras += 1;
      r.valor = r.valor.plus(toDecimal(x.compra.valor_compra));
      r.inferidas += x.inferido ? 1 : 0;
      resumen.set(clave, r);
    }

    const pagina_ = filtradas.slice((pagina - 1) * limite, pagina * limite);
    return {
      tarjeta: { id: idNum(tarjeta.id), franquicia: tarjeta.franquicia, descripcion: tarjeta.descripcion },
      plasticos: anotarPlasticos(this.ordenar(plasticosDb.map((p) => plasticoJson(p, compras.filter((c) => c.plastico_id === p.id).length)))),
      filtro: { plasticoId: f.plasticoId ?? null, desde: f.desde ?? null, hasta: f.hasta ?? null },
      totales,
      porPlastico: [...resumen.values()].map((r) => ({
        plasticoId: r.plastico ? idNum(r.plastico.id) : null,
        ultimos4: r.plastico?.ultimos_4 ?? null,
        esActivo: r.plastico?.es_activo ?? false,
        compras: r.compras,
        valorCompras: money(r.valor),
        inferidas: r.inferidas,
      })),
      paginacion: { pagina, limite, total: filtradas.length },
      compras: pagina_.map(({ compra: c, plastico, inferido }) => {
        const e = stats.get(c.id);
        return {
          id: idNum(c.id),
          concepto: c.concepto,
          fechaCompra: fecha(c.fecha_compra),
          valorCompra: money(toDecimal(c.valor_compra)),
          monedaOriginal: c.moneda_original,
          numeroCuotas: c.numero_cuotas ?? 0,
          cuotasPendientes: e?.pendientes ?? 0,
          saldoPendiente: money(toDecimal(e?.saldo ?? 0)),
          proximaCuota: fecha(e?.proxima ?? null),
          estado: c.estado,
          plastico: plastico ? { id: idNum(plastico.id), ultimos4: plastico.ultimos_4, esActivo: plastico.es_activo } : null,
          plasticoInferido: inferido,
          responsables: c.responsables.map((r) => ({
            personaId: r.persona === null ? null : idNum(r.persona),
            nombre: r.persona_ref?.nombre ?? null,
            porcentaje: r.porcentaje_pago === null ? null : toDecimal(r.porcentaje_pago),
            cuotas: r.cantidad_cuotas,
          })),
        };
      }),
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private estadisticasCuotas(tarjetaId: bigint, ownerUserId: bigint): Promise<EstadisticaCuotas[]> {
    return this.prisma.$queryRaw<EstadisticaCuotas[]>(Prisma.sql`
      SELECT cd.compra,
             count(*)::int AS total,
             (count(*) FILTER (WHERE ${Prisma.raw(NO_PAGADA)}))::int AS pendientes,
             COALESCE(sum(cd.pago_total) FILTER (WHERE ${Prisma.raw(NO_PAGADA)}), 0) AS saldo,
             min(cd.fecha_pago) FILTER (WHERE ${Prisma.raw(NO_PAGADA)}) AS proxima
      FROM "CuotasDetalle" cd
      JOIN "ComprasCredito" cc ON cc.id = cd.compra
      WHERE cc.tarjeta = ${tarjetaId}::int8 AND cc.owner_user_id = ${ownerUserId}::int8
        AND UPPER(COALESCE(cd.estado, '')) <> 'REFINANCIADA'
      GROUP BY cd.compra`);
  }

  private async requireTarjeta(tarjetaId: number, ownerUserId: bigint) {
    const t = await this.prisma.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId } });
    if (!t) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
    return t;
  }

  private fechaValida(texto: string, campo: string): Date {
    const d = parseIsoDate(texto);
    if (!d) throw datosInvalidos({ [campo]: [`${campo} debe tener formato yyyy-MM-dd`] });
    return d;
  }

  /** Activo primero; luego del más reciente al más antiguo. */
  private ordenar(lista: PlasticoJson[]): PlasticoJson[] {
    return [...lista].sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || b.id - a.id);
  }
}
