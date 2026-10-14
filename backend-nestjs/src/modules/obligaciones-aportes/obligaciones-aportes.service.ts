import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertObligacion, assertPersona } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateObligacionMesDto, RegistrarAportesDiaDto } from './dto/obligacion.dto';

/** Fila de resumen de una obligación del mes (mismos nombres que la vista `vw_ResumenObligacionesMes` del documento de BD). */
export interface ResumenObligacion {
  obligacion_mes_id: bigint;
  owner_user_id: bigint;
  tipo_obligacion: string;
  responsable_principal_id: bigint;
  responsable_principal_nombre: string | null;
  concepto: string;
  periodo: string;
  meta_mensual: Decimal;
  fecha_inicio: Date;
  fecha_final: Date | null;
  estado_calculado: 'COMPLETADO' | 'ABIERTO';
  dias_aportados: number;
  cantidad_registros: number;
  aporte_total_real: Decimal;
  restante_real: Decimal;
  aportado_directo_responsable: Decimal;
  aportado_por_cruces: Decimal;
}

/** Resumen de un día de aportes (mismos nombres que la vista `vw_AportesDiaResumen`). */
export interface ResumenDiaAportes {
  aporte_dia_id: bigint;
  obligacion_mes_id: bigint;
  mes_concepto: string;
  periodo: string;
  fecha: Date;
  notas: string | null;
  items_count: number;
  valor_total_dia: Decimal;
}

const sumar = (valores: Array<{ valor: Prisma.Decimal | Decimal }>): Decimal =>
  money(valores.reduce((acc, v) => acc.plus(toDecimal(v.valor)), new Decimal(0)));

/**
 * Obligaciones mensuales (cuota carro/casa) con aportes diarios.
 * Los aportes de un TERCERO los convierte el Trigger 3 (`trg_before_insert_aporte_detalle`) en un `Prestamos`
 * por cruce + 2 `AprobacionesPrestamos` (y el Trigger 4 lo carga al sub-ledger). NestJS NO crea ese préstamo.
 *
 * Los resúmenes se calculan aquí, sobre las tablas base, con la definición de las vistas del documento de BD
 * (`vw_ResumenObligacionesMes`, `vw_AportesDiaResumen`). No se leen las vistas: en el Supabase real tienen otra forma
 * (sin `owner_user_id`) o no existen, y de ellas dependía que `/api/obligaciones-mes` fallara con
 * "column vw_ResumenObligacionesMes.owner_user_id does not exist" (MIGRATION_INVENTORY D31).
 */
@Injectable()
export class ObligacionesAportesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resumen del mes de cada obligación del usuario, calculado desde `ObligacionesMes`/`AportesDia`/`AportesDetalle`. */
  private async resumenes(where: Prisma.ObligacionesMesWhereInput): Promise<ResumenObligacion[]> {
    const obligaciones = await this.prisma.obligacionesMes.findMany({
      where,
      include: {
        responsable_principal: { select: { nombre: true } },
        dias: { select: { id: true, detalles: { select: { persona_id: true, valor: true } } } },
      },
      orderBy: [{ periodo: 'desc' }, { id: 'desc' }],
    });

    return obligaciones.map((o) => {
      const detalles = o.dias.flatMap((d) => d.detalles);
      const meta = toDecimal(o.meta_mensual);
      const total = sumar(detalles);
      return {
        obligacion_mes_id: o.id,
        owner_user_id: o.owner_user_id,
        tipo_obligacion: o.tipo_obligacion,
        responsable_principal_id: o.responsable_principal_id,
        responsable_principal_nombre: o.responsable_principal.nombre,
        concepto: o.concepto,
        periodo: o.periodo,
        meta_mensual: meta,
        fecha_inicio: o.fecha_inicio,
        fecha_final: o.fecha_final,
        estado_calculado: total.greaterThanOrEqualTo(meta) ? 'COMPLETADO' : 'ABIERTO',
        dias_aportados: o.dias.length,
        cantidad_registros: detalles.length,
        aporte_total_real: total,
        restante_real: money(meta.minus(total)),
        aportado_directo_responsable: sumar(detalles.filter((d) => d.persona_id === o.responsable_principal_id)),
        aportado_por_cruces: sumar(detalles.filter((d) => d.persona_id !== o.responsable_principal_id)),
      };
    });
  }

  listResumen(ownerUserId: bigint, periodo?: string, tipo?: string) {
    return this.resumenes({
      owner_user_id: ownerUserId,
      ...(periodo ? { periodo } : {}),
      ...(tipo ? { tipo_obligacion: tipo } : {}),
    });
  }

  async resumen(obligacionId: number, ownerUserId: bigint) {
    const [fila] = await this.resumenes({ id: BigInt(obligacionId), owner_user_id: ownerUserId });
    if (!fila) throw new NotFoundException(`Obligación mensual ${obligacionId} no encontrada`);
    return fila;
  }

  /** Resumen de un día (cuántos ítems y cuánto suma) a partir de su `AportesDia` y sus ítems. */
  private resumenDia(
    dia: { id: bigint; obligacion_mes_id: bigint; fecha: Date; notas: string | null },
    obligacion: { concepto: string; periodo: string },
    detalles: Array<{ valor: Prisma.Decimal | Decimal }>,
  ): ResumenDiaAportes {
    return {
      aporte_dia_id: dia.id,
      obligacion_mes_id: dia.obligacion_mes_id,
      mes_concepto: obligacion.concepto,
      periodo: obligacion.periodo,
      fecha: dia.fecha,
      notas: dia.notas,
      items_count: detalles.length,
      valor_total_dia: sumar(detalles),
    };
  }

  async create(dto: CreateObligacionMesDto, ownerUserId: bigint) {
    const inicio = parseIsoDate(dto.fechaInicio);
    const fin = dto.fechaFinal ? parseIsoDate(dto.fechaFinal) : null;
    if (!inicio || (dto.fechaFinal && !fin)) {
      throw datosInvalidos({ fechas: ['Las fechas deben tener formato yyyy-MM-dd'] });
    }
    return this.prisma.$transaction(async (tx) => {
      await assertPersona(tx, dto.responsablePrincipalId, ownerUserId);
      return tx.obligacionesMes.create({
        data: {
          owner_user_id: ownerUserId,
          tipo_obligacion: dto.tipoObligacion,
          responsable_principal_id: BigInt(dto.responsablePrincipalId),
          concepto: dto.concepto,
          periodo: dto.periodo,
          meta_mensual: toDbMoney(toDecimal(dto.metaMensual)),
          fecha_inicio: inicio,
          fecha_final: fin,
          estado: 'ABIERTO',
        },
      });
    });
  }

  /** Resumen diario + desglose de `AportesDetalle` con los datos de `Personas`, del más reciente al más antiguo. */
  async aportesDia(obligacionId: number, ownerUserId: bigint) {
    const obligacion = await assertObligacion(this.prisma, obligacionId, ownerUserId);
    const dias = await this.prisma.aportesDia.findMany({
      where: { obligacion_mes_id: obligacion.id },
      include: {
        detalles: {
          include: { persona: { select: { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } } },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
    });
    return dias.map(({ detalles, ...dia }) => ({ ...this.resumenDia(dia, obligacion, detalles), detalles }));
  }

  /** Busca o crea el `AportesDia` de (obligación, fecha) e inserta los ítems; devuelve el día con su desglose. */
  async registrarAportesDia(obligacionId: number, dto: RegistrarAportesDiaDto, ownerUserId: bigint) {
    const fecha = parseIsoDate(dto.fecha);
    if (!fecha) throw datosInvalidos({ fecha: ['fecha debe tener formato yyyy-MM-dd'] });

    const diaId = await this.prisma.$transaction(async (tx) => {
      const obligacion = await assertObligacion(tx, obligacionId, ownerUserId);
      for (const personaId of new Set(dto.items.map((i) => i.personaId))) {
        await assertPersona(tx, personaId, ownerUserId);
      }

      const existente = await tx.aportesDia.findFirst({ where: { obligacion_mes_id: obligacion.id, fecha } });
      const dia =
        existente ??
        (await tx.aportesDia.create({
          data: { obligacion_mes_id: obligacion.id, fecha, notas: dto.notas ?? null },
        }));
      if (existente && dto.notas !== undefined && dto.notas !== existente.notas) {
        await tx.aportesDia.update({ where: { id: dia.id }, data: { notas: dto.notas } });
      }

      // Uno a uno: el trigger BEFORE INSERT completa `prestamo_cruce_generado_id` en cada fila.
      for (const item of dto.items) {
        const valor = money(toDecimal(item.valor));
        if (!valor.greaterThan(0)) throw datosInvalidos({ valor: ['valor debe ser mayor a 0'] });
        await tx.aportesDetalle.create({
          data: {
            aporte_dia_id: dia.id,
            persona_id: BigInt(item.personaId),
            valor: toDbMoney(valor),
            metodo: item.metodo,
            comentarios: item.comentarios ?? null,
          },
        });
      }
      return dia.id;
    });

    const [dia, detalles] = await Promise.all([
      this.prisma.aportesDia.findUniqueOrThrow({
        where: { id: diaId },
        include: { obligacion_mes: { select: { concepto: true, periodo: true } } },
      }),
      this.prisma.aportesDetalle.findMany({
        where: { aporte_dia_id: diaId },
        include: {
          persona: { select: { id: true, nombre: true } },
          prestamo_cruce: { select: { id: true, estado: true, valor_prestado: true, corte_id: true } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    return { ...this.resumenDia(dia, dia.obligacion_mes, detalles), detalles };
  }
}
