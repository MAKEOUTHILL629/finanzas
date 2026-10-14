import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidPeriodo, parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCuenta, assertPeriodoRecurrente, assertPersona, assertPrestamo } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AbonarPersonaDto, CreateCruceDeudaDto } from './dto/subledger.dto';

export interface EstadoCuentaPersonaRow {
  persona_id: bigint;
  nombre: string | null;
  iniciales_nombre: string | null;
  color_representativo: string | null;
  cuotas_tc_mes: Prisma.Decimal;
  recurrentes_compartidos_mes: Prisma.Decimal;
  prestamos_mes: Prisma.Decimal;
  cruces_asumidos_mes: Prisma.Decimal;
  abonos_recibidos_mes: Prisma.Decimal;
  saldo_neto_mes: Prisma.Decimal;
  saldo_total_acumulado: Prisma.Decimal;
}

export interface FlujoCajaRow {
  total_ingresos: Prisma.Decimal;
  total_egresos_directos: Prisma.Decimal;
  total_tarjetas: Prisma.Decimal;
  total_esperado_recurrentes: Prisma.Decimal;
  total_por_cobrar_terceros: Prisma.Decimal;
  desembolso_bruto_mes: Prisma.Decimal;
  gasto_neto_real_tuyo: Prisma.Decimal;
  flujo_caja_libre_estimado: Prisma.Decimal;
}

/**
 * Sub-ledger de deudas (`MovimientosDeudaPersona`). Los asientos los generan los triggers 4-8 y el SP de abonos;
 * este servicio solo dispara esos mecanismos y consulta.
 */
@Injectable()
export class SubledgerDeudasService {
  constructor(private readonly prisma: PrismaService) {}

  /** Inserta en `CrucesDeuda`; el Trigger 5 crea el abono (-1) y el cargo (+1). */
  async crearCruce(dto: CreateCruceDeudaDto, ownerUserId: bigint) {
    if (dto.personaQueAbonaId === dto.personaQueAsumeDeudaId) {
      throw datosInvalidos({ personaQueAsumeDeudaId: ['La persona que abona y la que asume la deuda deben ser distintas'] });
    }
    const fecha = dto.fechaCruce ? parseIsoDate(dto.fechaCruce) : todayLocal();
    if (!fecha) throw datosInvalidos({ fechaCruce: ['fechaCruce debe tener formato yyyy-MM-dd'] });
    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });

    const cruceId = await this.prisma.$transaction(async (tx) => {
      await assertPersona(tx, dto.personaQueAbonaId, ownerUserId);
      await assertPersona(tx, dto.personaQueAsumeDeudaId, ownerUserId);
      if (dto.prestamoDestinoId) await assertPrestamo(tx, dto.prestamoDestinoId, ownerUserId);
      if (dto.periodoRecurrenteDestinoId) await assertPeriodoRecurrente(tx, dto.periodoRecurrenteDestinoId, ownerUserId);

      const cruce = await tx.crucesDeuda.create({
        data: {
          owner_user_id: ownerUserId,
          fecha_cruce: fecha,
          persona_que_abona_id: BigInt(dto.personaQueAbonaId),
          persona_que_asume_deuda_id: BigInt(dto.personaQueAsumeDeudaId),
          monto: toDbMoney(monto),
          prestamo_destino_id: dto.prestamoDestinoId ? BigInt(dto.prestamoDestinoId) : null,
          periodo_recurrente_destino_id: dto.periodoRecurrenteDestinoId ? BigInt(dto.periodoRecurrenteDestinoId) : null,
          concepto: dto.concepto,
          comentarios: dto.comentarios ?? null,
        },
      });
      return cruce.id;
    });

    return this.prisma.crucesDeuda.findUniqueOrThrow({
      where: { id: cruceId },
      include: { movimientos: { orderBy: { id: 'asc' } } },
    });
  }

  listCruces(ownerUserId: bigint) {
    return this.prisma.crucesDeuda.findMany({
      where: { owner_user_id: ownerUserId },
      include: {
        persona_que_abona: { select: { id: true, nombre: true } },
        persona_que_asume: { select: { id: true, nombre: true } },
      },
      orderBy: [{ fecha_cruce: 'desc' }, { id: 'desc' }],
    });
  }

  /** `POST /api/v2/personas/:id/abonar` → `sp_registrar_abono_persona`. Devuelve el id del movimiento. */
  async abonarPersona(personaId: number, dto: AbonarPersonaDto, ownerUserId: bigint) {
    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });

    await this.prisma.$transaction(async (tx) => {
      await assertPersona(tx, personaId, ownerUserId);
      await assertCuenta(tx, dto.cuentaDestinoId, ownerUserId);
      if (dto.liquidarPrestamosCorteId) {
        const corte = await tx.cortesCobro.findFirst({
          where: { id: BigInt(dto.liquidarPrestamosCorteId), owner_user_id: ownerUserId },
          select: { id: true },
        });
        if (!corte) throw datosInvalidos({ liquidarPrestamosCorteId: ['El corte no existe'] });
      }
    });

    const corteId = dto.liquidarPrestamosCorteId ? BigInt(dto.liquidarPrestamosCorteId) : null;
    let rows: Array<{ movimiento_id: bigint }>;
    try {
      rows = await this.prisma.$queryRaw<Array<{ movimiento_id: bigint }>>`
        SELECT sp_registrar_abono_persona(
          ${ownerUserId}::int8, ${BigInt(personaId)}::int8, ${BigInt(dto.cuentaDestinoId)}::int8,
          ${toDbMoney(monto)}::numeric(15,2), ${dto.periodoImputacion}::char(7), ${dto.concepto}::varchar, ${corteId}::int8
        ) AS movimiento_id`;
    } catch (error) {
      if (corteId === null) throw error;
      // El SP liquida los préstamos con `saldo_pendiente = 0` en el mismo UPDATE que `estado = 'Pagado'`; el Trigger 4
      // intenta entonces un abono de monto 0, que viola el CHECK (monto > 0) del sub-ledger. La transacción se revierte.
      throw new HttpException(
        {
          message:
            'No se pudo liquidar los préstamos del corte con sp_registrar_abono_persona: el trigger de préstamos ' +
            'intenta registrar un abono de monto 0 (viola monto > 0). Registra el abono sin `liquidarPrestamosCorteId` ' +
            'o corrige fn_sync_prestamo_to_subledger para omitir abonos de monto 0. No se registró nada.',
          detalle: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return {
      movimientoId: Number(rows[0]?.movimiento_id),
      personaId,
      monto: monto.toNumber(),
      periodoImputacion: dto.periodoImputacion,
    };
  }

  /** 7.1 — Estado de cuenta consolidado por persona a fin de mes. */
  async estadoCuenta(periodo: string, ownerUserId: bigint): Promise<EstadoCuentaPersonaRow[]> {
    this.exigirPeriodo(periodo);
    return this.prisma.$queryRaw<EstadoCuentaPersonaRow[]>`
      SELECT
        p.id AS persona_id,
        p.nombre,
        p.iniciales_nombre,
        p.color_representativo,
        SUM(CASE WHEN m.tipo_movimiento = 'CARGO_CUOTA_TC' AND m.periodo_imputacion = ${periodo}::char(7) THEN m.monto ELSE 0 END) AS cuotas_tc_mes,
        SUM(CASE WHEN m.tipo_movimiento = 'CARGO_GASTO_COMPARTIDO' AND m.periodo_imputacion = ${periodo}::char(7) THEN m.monto ELSE 0 END) AS recurrentes_compartidos_mes,
        SUM(CASE WHEN m.tipo_movimiento = 'CARGO_PRESTAMO_DIRECTO' AND m.periodo_imputacion = ${periodo}::char(7) THEN m.monto ELSE 0 END) AS prestamos_mes,
        SUM(CASE WHEN m.tipo_movimiento = 'CARGO_CRUCE_DEUDA' AND m.periodo_imputacion = ${periodo}::char(7) THEN m.monto ELSE 0 END) AS cruces_asumidos_mes,
        SUM(CASE WHEN m.signo = -1 AND m.periodo_imputacion = ${periodo}::char(7) THEN m.monto ELSE 0 END) AS abonos_recibidos_mes,
        SUM(CASE WHEN m.periodo_imputacion = ${periodo}::char(7) THEN (m.monto * m.signo) ELSE 0 END) AS saldo_neto_mes,
        SUM(CASE WHEN m.periodo_imputacion <= ${periodo}::char(7) AND m.estado = 'CONFIRMADO' THEN (m.monto * m.signo) ELSE 0 END) AS saldo_total_acumulado
      FROM "Personas" p
      LEFT JOIN "MovimientosDeudaPersona" m ON m.persona_id = p.id
      WHERE p.owner_user_id = ${ownerUserId}::int8
      GROUP BY p.id, p.nombre, p.iniciales_nombre, p.color_representativo
      ORDER BY saldo_total_acumulado DESC`;
  }

  /** 7.2 — Extracto detallado de una persona en un periodo. */
  async extracto(personaId: number, periodo: string, ownerUserId: bigint) {
    this.exigirPeriodo(periodo);
    await assertPersona(this.prisma, personaId, ownerUserId);
    return this.prisma.$queryRaw<
      Array<{
        id: bigint;
        fecha_movimiento: Date;
        periodo_imputacion: string;
        tipo_movimiento: string;
        concepto: string;
        signo: number;
        monto: Prisma.Decimal;
        impacto_saldo: Prisma.Decimal;
        estado: string | null;
      }>
    >`
      SELECT
        m.id,
        m.fecha_movimiento,
        m.periodo_imputacion,
        m.tipo_movimiento,
        m.concepto,
        m.signo,
        m.monto,
        (m.monto * m.signo) AS impacto_saldo,
        m.estado
      FROM "MovimientosDeudaPersona" m
      WHERE m.owner_user_id = ${ownerUserId}::int8
        AND m.persona_id = ${BigInt(personaId)}::int8
        AND m.periodo_imputacion = ${periodo}::char(7)
      ORDER BY m.fecha_movimiento ASC, m.id ASC`;
  }

  /** 7.4 — Tablero de pronóstico de flujo de caja mensual (una sola fila). */
  async flujoCaja(periodo: string, ownerUserId: bigint): Promise<FlujoCajaRow> {
    this.exigirPeriodo(periodo);
    const rows = await this.prisma.$queryRaw<FlujoCajaRow[]>`
      WITH ingresos_mes AS (
        SELECT COALESCE(SUM(monto_cop), 0) AS total_ingresos
        FROM "Transacciones"
        WHERE owner_user_id = ${ownerUserId}::int8
          AND tipo_transaccion = 'INGRESO'
          AND estado = 'CONFIRMADO'
          AND to_char(fecha_transaccion, 'YYYY-MM') = ${periodo}::text
      ),
      gastos_diarios_mes AS (
        SELECT COALESCE(SUM(monto_cop), 0) AS total_egresos_directos
        FROM "Transacciones"
        WHERE owner_user_id = ${ownerUserId}::int8
          AND tipo_transaccion = 'EGRESO'
          AND estado = 'CONFIRMADO'
          AND to_char(fecha_transaccion, 'YYYY-MM') = ${periodo}::text
      ),
      tarjetas_mes AS (
        SELECT COALESCE(SUM(cd.pago_total), 0) AS total_tarjetas
        FROM "CuotasDetalle" cd
        JOIN "ComprasCredito" cc ON cc.id = cd.compra
        WHERE cc.owner_user_id = ${ownerUserId}::int8
          AND cd.periodo_facturacion = ${periodo}::char(7)
      ),
      recurrentes_mes AS (
        SELECT
          COALESCE(SUM(monto_pronosticado), 0) AS total_pronosticado,
          COALESCE(SUM(COALESCE(monto_real_pagado, monto_pronosticado)), 0) AS total_esperado_recurrentes
        FROM "PeriodosRecurrentes"
        WHERE owner_user_id = ${ownerUserId}::int8
          AND periodo = ${periodo}::char(7)
          AND estado <> 'OMITIDO'
      ),
      reembolsos_terceros_mes AS (
        SELECT COALESCE(SUM(monto), 0) AS total_por_cobrar_terceros
        FROM "MovimientosDeudaPersona"
        WHERE owner_user_id = ${ownerUserId}::int8
          AND periodo_imputacion = ${periodo}::char(7)
          AND signo = 1
      )
      SELECT
        i.total_ingresos::numeric(15,2) AS total_ingresos,
        g.total_egresos_directos::numeric(15,2) AS total_egresos_directos,
        t.total_tarjetas::numeric(15,2) AS total_tarjetas,
        r.total_esperado_recurrentes::numeric(15,2) AS total_esperado_recurrentes,
        reem.total_por_cobrar_terceros::numeric(15,2) AS total_por_cobrar_terceros,
        (t.total_tarjetas + r.total_esperado_recurrentes + g.total_egresos_directos)::numeric(15,2) AS desembolso_bruto_mes,
        (t.total_tarjetas + r.total_esperado_recurrentes + g.total_egresos_directos - reem.total_por_cobrar_terceros)::numeric(15,2) AS gasto_neto_real_tuyo,
        (i.total_ingresos - (t.total_tarjetas + r.total_esperado_recurrentes + g.total_egresos_directos - reem.total_por_cobrar_terceros))::numeric(15,2) AS flujo_caja_libre_estimado
      FROM ingresos_mes i
      CROSS JOIN gastos_diarios_mes g
      CROSS JOIN tarjetas_mes t
      CROSS JOIN recurrentes_mes r
      CROSS JOIN reembolsos_terceros_mes reem`;
    return rows[0];
  }

  private exigirPeriodo(periodo: string): void {
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
  }
}
