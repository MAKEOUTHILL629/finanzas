import { Injectable, NotFoundException } from '@nestjs/common';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertObligacion, assertPersona } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateObligacionMesDto, RegistrarAportesDiaDto } from './dto/obligacion.dto';

/**
 * Obligaciones mensuales (cuota carro/casa) con aportes diarios.
 * Los aportes de un TERCERO los convierte el Trigger 3 (`trg_before_insert_aporte_detalle`) en un `Prestamos`
 * por cruce + 2 `AprobacionesPrestamos` (y el Trigger 4 lo carga al sub-ledger). NestJS NO crea ese préstamo.
 */
@Injectable()
export class ObligacionesAportesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lectura desde la vista calculada `vw_ResumenObligacionesMes`. */
  listResumen(ownerUserId: bigint, periodo?: string, tipo?: string) {
    return this.prisma.vw_ResumenObligacionesMes.findMany({
      where: {
        owner_user_id: ownerUserId,
        ...(periodo ? { periodo } : {}),
        ...(tipo ? { tipo_obligacion: tipo } : {}),
      },
      orderBy: [{ periodo: 'desc' }, { obligacion_mes_id: 'desc' }],
    });
  }

  async resumen(obligacionId: number, ownerUserId: bigint) {
    const fila = await this.prisma.vw_ResumenObligacionesMes.findFirst({
      where: { obligacion_mes_id: BigInt(obligacionId), owner_user_id: ownerUserId },
    });
    if (!fila) throw new NotFoundException(`Obligación mensual ${obligacionId} no encontrada`);
    return fila;
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

  /** Resumen diario (`vw_AportesDiaResumen`) + desglose de `AportesDetalle` con los datos de `Personas`. */
  async aportesDia(obligacionId: number, ownerUserId: bigint) {
    const obligacion = await assertObligacion(this.prisma, obligacionId, ownerUserId);
    const [resumenes, detalles] = await Promise.all([
      this.prisma.vw_AportesDiaResumen.findMany({
        where: { obligacion_mes_id: obligacion.id },
        orderBy: { fecha: 'desc' },
      }),
      this.prisma.aportesDetalle.findMany({
        where: { aporte_dia: { obligacion_mes_id: obligacion.id } },
        include: { persona: { select: { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    return resumenes.map((dia) => ({
      ...dia,
      detalles: detalles.filter((d) => d.aporte_dia_id === dia.aporte_dia_id),
    }));
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

    const [resumen, detalles] = await Promise.all([
      this.prisma.vw_AportesDiaResumen.findFirst({ where: { aporte_dia_id: diaId } }),
      this.prisma.aportesDetalle.findMany({
        where: { aporte_dia_id: diaId },
        include: {
          persona: { select: { id: true, nombre: true } },
          prestamo_cruce: { select: { id: true, estado: true, valor_prestado: true, corte_id: true } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    return { ...resumen, detalles };
  }
}
