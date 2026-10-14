import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoCargoRecurrentePersona, EstadoMovimientoDeuda, ModalidadDuracion, NaturalezaRecurrentePersona } from '../../common/enums/finance.enums';
import { isValidPeriodo, periodoActual } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertPersona } from '../../common/utils/ownership.util';
import { addMesesPeriodo } from '../../common/utils/periodo.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarRecurrentePersonaDto, CrearRecurrentePersonaDto, FiltroRecurrentesPersonaDto } from './dto/recurrente-persona.dto';

type CargoConPersona = Prisma.CargosRecurrentesPersonaGetPayload<{ include: { persona: { select: { id: true; nombre: true; iniciales_nombre: true; color_representativo: true } } } }>;

const INCLUDE_PERSONA = { persona: { select: { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } } } as const;
/** Cuántos meses hacia adelante se admite proyectar (evita llenar el sub-ledger de meses lejanos). */
const MESES_FUTURO_MAXIMOS = 24;

/** Mes fin de un recurrente por plazo fijo: `mesInicio` + (X − 1) meses; `null` si es indefinido. */
export function calcularMesFin(modalidad: string, mesInicio: string, numeroMeses: number | null): string | null {
  return modalidad === ModalidadDuracion.PLAZO_FIJO && numeroMeses ? addMesesPeriodo(mesInicio, numeroMeses - 1) : null;
}

/**
 * Cargos y abonos mensuales recurrentes por persona, vitalicios (`INDEFINIDO`) o por un plazo de X meses (`PLAZO_FIJO`).
 *
 * Cada mes se materializa en el sub-ledger (`MovimientosDeudaPersona`) de forma IDEMPOTENTE: la clave
 * `RECP_<id>_<YYYY-MM>` (`appsheet_row_id`, UNIQUE) hace que generar dos veces el mismo mes no duplique nada.
 * Los meses futuros quedan `PROYECTADO` y pasan a `CONFIRMADO` cuando llega el mes.
 */
@Injectable()
export class RecurrentesPersonaService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerUserId: bigint, filtro: FiltroRecurrentesPersonaDto = {}) {
    const cargos = await this.prisma.cargosRecurrentesPersona.findMany({
      where: {
        owner_user_id: ownerUserId,
        ...(filtro.personaId !== undefined ? { persona_id: BigInt(filtro.personaId) } : {}),
        ...(filtro.activo !== undefined ? { activo: filtro.activo } : {}),
        ...(filtro.modalidadDuracion ? { modalidad_duracion: filtro.modalidadDuracion } : {}),
      },
      include: INCLUDE_PERSONA,
      orderBy: [{ activo: 'desc' }, { id: 'desc' }],
    });
    return cargos.map((c) => this.vista(c));
  }

  async get(id: number, ownerUserId: bigint) {
    const cargo = await this.prisma.cargosRecurrentesPersona.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, include: INCLUDE_PERSONA });
    if (!cargo) throw new NotFoundException(`Recurrente por persona ${id} no encontrado`);
    return this.vista(cargo);
  }

  async create(dto: CrearRecurrentePersonaDto, ownerUserId: bigint) {
    const modalidad = dto.modalidadDuracion ?? ModalidadDuracion.INDEFINIDO;
    const numeroMeses = this.resolverDuracion(modalidad, dto.numeroMeses, null);
    const mesInicio = dto.mesInicio ?? periodoActual();
    const valor = money(toDecimal(dto.valorMensual));
    if (!valor.greaterThan(0)) throw datosInvalidos({ valorMensual: ['valorMensual debe ser mayor a 0'] });

    const id = await this.prisma.$transaction(async (tx) => {
      const personaId = await assertPersona(tx, dto.personaId, ownerUserId);
      const creado = await tx.cargosRecurrentesPersona.create({
        data: {
          owner_user_id: ownerUserId,
          persona_id: personaId,
          concepto: dto.concepto.trim(),
          valor_mensual: toDbMoney(valor),
          naturaleza: dto.naturaleza ?? NaturalezaRecurrentePersona.CARGO_A_COBRAR,
          modalidad_duracion: modalidad,
          numero_meses: numeroMeses,
          mes_inicio: mesInicio,
          mes_fin: calcularMesFin(modalidad, mesInicio, numeroMeses),
          dia_cobro: dto.diaCobro ?? 1,
          activo: dto.activo ?? true,
          estado: EstadoCargoRecurrentePersona.ACTIVO,
          notas: dto.notas ?? null,
        },
      });
      return creado.id;
    });
    return this.get(Number(id), ownerUserId);
  }

  async update(id: number, dto: ActualizarRecurrentePersonaDto, ownerUserId: bigint) {
    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.cargosRecurrentesPersona.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Recurrente por persona ${id} no encontrado`);

      const modalidad = dto.modalidadDuracion ?? actual.modalidad_duracion;
      const numeroMeses = this.resolverDuracion(modalidad, dto.numeroMeses, actual.numero_meses);

      const mesInicio = dto.mesInicio ?? actual.mes_inicio;
      if (mesInicio !== actual.mes_inicio && actual.cuotas_generadas > 0) {
        throw new ConflictException('No se puede cambiar el mes de inicio de un recurrente que ya generó cuotas: elimínalo y créalo de nuevo');
      }
      if (dto.naturaleza && dto.naturaleza !== actual.naturaleza && actual.cuotas_generadas > 0) {
        throw new ConflictException('No se puede cambiar la naturaleza de un recurrente que ya generó cuotas: elimínalo y créalo de nuevo');
      }
      if (modalidad === ModalidadDuracion.PLAZO_FIJO && numeroMeses !== null && numeroMeses < actual.cuotas_generadas) {
        throw datosInvalidos({ numeroMeses: [`Ya se generaron ${actual.cuotas_generadas} cuotas: el plazo no puede ser menor`] });
      }

      const valor = dto.valorMensual === undefined ? null : money(toDecimal(dto.valorMensual));
      if (valor !== null && !valor.greaterThan(0)) throw datosInvalidos({ valorMensual: ['valorMensual debe ser mayor a 0'] });

      const finalizado = modalidad === ModalidadDuracion.PLAZO_FIJO && numeroMeses !== null && actual.cuotas_generadas >= numeroMeses;
      const activo = dto.activo ?? actual.activo;
      await tx.cargosRecurrentesPersona.update({
        where: { id: actual.id },
        data: {
          ...(dto.concepto !== undefined ? { concepto: dto.concepto.trim() } : {}),
          ...(valor !== null ? { valor_mensual: toDbMoney(valor) } : {}),
          ...(dto.naturaleza !== undefined ? { naturaleza: dto.naturaleza } : {}),
          ...(dto.diaCobro !== undefined ? { dia_cobro: dto.diaCobro } : {}),
          ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
          activo,
          modalidad_duracion: modalidad,
          numero_meses: numeroMeses,
          mes_inicio: mesInicio,
          mes_fin: calcularMesFin(modalidad, mesInicio, numeroMeses),
          estado: finalizado ? EstadoCargoRecurrentePersona.FINALIZADO : EstadoCargoRecurrentePersona.ACTIVO,
          updated_at: new Date(),
        },
      });

      // El historial confirmado no se reescribe; solo se ajusta lo proyectado (meses futuros).
      if (valor !== null) {
        await tx.movimientosDeudaPersona.updateMany({
          where: { cargo_recurrente_persona_id: actual.id, estado: EstadoMovimientoDeuda.PROYECTADO },
          data: { monto: toDbMoney(valor) },
        });
      }
      if (!activo) {
        await tx.movimientosDeudaPersona.updateMany({
          where: { cargo_recurrente_persona_id: actual.id, estado: EstadoMovimientoDeuda.PROYECTADO },
          data: { estado: EstadoMovimientoDeuda.ANULADO },
        });
      }
    });
    return this.get(id, ownerUserId);
  }

  /** Elimina el recurrente y anula sus asientos del sub-ledger (se conservan como ANULADO, sin contar en el estado de cuenta). */
  async remove(id: number, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const actual = await tx.cargosRecurrentesPersona.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Recurrente por persona ${id} no encontrado`);
      const anulados = await tx.movimientosDeudaPersona.updateMany({
        where: { cargo_recurrente_persona_id: actual.id, estado: { not: EstadoMovimientoDeuda.ANULADO } },
        data: { estado: EstadoMovimientoDeuda.ANULADO },
      });
      await tx.cargosRecurrentesPersona.delete({ where: { id: actual.id } });
      return { eliminado: true, movimientosAnulados: anulados.count };
    });
  }

  /**
   * Genera (idempotente) los cargos/abonos de todos los recurrentes activos desde su `mes_inicio` hasta `periodo`,
   * respetando el plazo (k ≤ X), y actualiza `cuotas_generadas` / `estado`. Se invoca antes de calcular la liquidación del mes.
   */
  async generarMes(periodo: string, ownerUserId: bigint) {
    this.exigirPeriodo(periodo);
    const ahora = periodoActual();

    const generados = await this.prisma.$executeRaw`
      INSERT INTO "MovimientosDeudaPersona" (
        owner_user_id, persona_id, fecha_movimiento, periodo_imputacion, tipo_movimiento, signo, monto,
        cargo_recurrente_persona_id, appsheet_row_id, concepto, estado
      )
      SELECT
        c.owner_user_id,
        c.persona_id,
        make_date(m.anio, m.mes, LEAST(c.dia_cobro::int, m.ultimo_dia)),
        m.periodo,
        CASE WHEN c.naturaleza = 'ABONO_A_FAVOR' THEN 'ABONO_RECURRENTE_PERSONA' ELSE 'CARGO_RECURRENTE_PERSONA' END,
        CASE WHEN c.naturaleza = 'ABONO_A_FAVOR' THEN -1 ELSE 1 END,
        c.valor_mensual,
        c.id,
        'RECP_' || c.id || '_' || m.periodo,
        CASE
          WHEN c.modalidad_duracion = 'PLAZO_FIJO' THEN c.concepto || ' (Cuota ' || m.k || ' de ' || c.numero_meses || ')'
          ELSE c.concepto || ' (Mensual Recurrente)'
        END,
        CASE WHEN m.periodo <= ${ahora}::text THEN 'CONFIRMADO' ELSE 'PROYECTADO' END
      FROM "CargosRecurrentesPersona" c
      CROSS JOIN LATERAL (
        SELECT
          to_char(d, 'YYYY-MM') AS periodo,
          EXTRACT(YEAR FROM d)::int AS anio,
          EXTRACT(MONTH FROM d)::int AS mes,
          EXTRACT(DAY FROM (date_trunc('month', d) + interval '1 month - 1 day'))::int AS ultimo_dia,
          ((EXTRACT(YEAR FROM d)::int * 12 + EXTRACT(MONTH FROM d)::int)
            - (substr(c.mes_inicio, 1, 4)::int * 12 + substr(c.mes_inicio, 6, 2)::int) + 1) AS k
        FROM generate_series(
          to_date(c.mes_inicio || '-01', 'YYYY-MM-DD'),
          to_date(LEAST(${periodo}::text, COALESCE(c.mes_fin, ${periodo}::text)) || '-01', 'YYYY-MM-DD'),
          interval '1 month'
        ) AS d
      ) m
      WHERE c.owner_user_id = ${ownerUserId}::int8
        AND c.activo = true
        AND c.estado = 'ACTIVO'
      ON CONFLICT (appsheet_row_id) DO UPDATE
        SET monto = EXCLUDED.monto, estado = EXCLUDED.estado, concepto = EXCLUDED.concepto
        WHERE "MovimientosDeudaPersona".estado IN ('PROYECTADO', 'ANULADO')`;

    // Cuotas generadas = asientos vigentes; un plazo fijo se cierra al generar la cuota X.
    await this.prisma.$executeRaw`
      UPDATE "CargosRecurrentesPersona" c
      SET cuotas_generadas = x.n,
          estado = CASE WHEN c.modalidad_duracion = 'PLAZO_FIJO' AND x.n >= c.numero_meses THEN 'FINALIZADO' ELSE 'ACTIVO' END,
          updated_at = now()
      FROM (
        SELECT cargo_recurrente_persona_id AS id, count(*)::int AS n
        FROM "MovimientosDeudaPersona"
        WHERE owner_user_id = ${ownerUserId}::int8
          AND cargo_recurrente_persona_id IS NOT NULL
          AND COALESCE(estado, 'CONFIRMADO') <> 'ANULADO'
        GROUP BY cargo_recurrente_persona_id
      ) x
      WHERE c.id = x.id
        AND c.owner_user_id = ${ownerUserId}::int8
        AND (
          c.cuotas_generadas IS DISTINCT FROM x.n
          OR c.estado <> CASE WHEN c.modalidad_duracion = 'PLAZO_FIJO' AND x.n >= c.numero_meses THEN 'FINALIZADO' ELSE 'ACTIVO' END
        )`;

    const recurrentes = await this.list(ownerUserId);
    return { periodo, movimientosGenerados: Number(generados), recurrentes };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private exigirPeriodo(periodo: string): void {
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    const limite = addMesesPeriodo(periodoActual(), MESES_FUTURO_MAXIMOS);
    if (periodo < '2000-01' || periodo > limite) {
      throw datosInvalidos({ periodo: [`periodo debe estar entre 2000-01 y ${limite} (máximo ${MESES_FUTURO_MAXIMOS} meses hacia adelante)`] });
    }
  }

  /** Plazo efectivo: obligatorio con PLAZO_FIJO, prohibido con INDEFINIDO. */
  private resolverDuracion(modalidad: string, pedido: number | undefined, actual: number | null): number | null {
    if (modalidad === ModalidadDuracion.INDEFINIDO) {
      if (pedido !== undefined) throw datosInvalidos({ numeroMeses: ['numeroMeses no aplica a un recurrente INDEFINIDO (de por vida)'] });
      return null;
    }
    const numeroMeses = pedido ?? actual;
    if (numeroMeses === null) throw datosInvalidos({ numeroMeses: ['numeroMeses es obligatorio con modalidad PLAZO_FIJO'] });
    return numeroMeses;
  }

  private vista(c: CargoConPersona) {
    const plazo = c.modalidad_duracion === ModalidadDuracion.PLAZO_FIJO && c.numero_meses !== null;
    return {
      id: c.id,
      personaId: c.persona_id,
      personaNombre: c.persona.nombre,
      personaIniciales: c.persona.iniciales_nombre,
      personaColor: c.persona.color_representativo,
      concepto: c.concepto,
      valorMensual: money(toDecimal(c.valor_mensual)),
      naturaleza: c.naturaleza,
      modalidadDuracion: c.modalidad_duracion,
      vitalicio: c.modalidad_duracion === ModalidadDuracion.INDEFINIDO,
      numeroMeses: c.numero_meses,
      mesInicio: c.mes_inicio,
      mesFin: c.mes_fin,
      cuotasGeneradas: c.cuotas_generadas,
      diaCobro: c.dia_cobro,
      activo: c.activo,
      estado: c.estado,
      notas: c.notas,
      progreso: plazo
        ? {
            actual: c.cuotas_generadas,
            total: c.numero_meses as number,
            porcentaje: Math.min(100, Math.round((c.cuotas_generadas / (c.numero_meses as number)) * 100)),
          }
        : null,
    };
  }
}
