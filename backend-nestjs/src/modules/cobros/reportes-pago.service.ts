import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoMovimientoDeuda, EstadoTransaccion, TipoMovimientoDeuda, TipoTransaccion } from '../../common/enums/finance.enums';
import { periodoOf, todayLocal } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCuenta, assertPersona } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { AplicarIngresoDto, AprobarReporteDto, FiltroReportesDto, RechazarReporteDto } from './dto/cobros.dto';
import { EnlacesCobroService } from './enlaces-cobro.service';

type Tx = Prisma.TransactionClient;

/** Columnas de un reporte SIN el comprobante (los bytes solo se piden aparte). */
const SIN_COMPROBANTE = {
  id: true,
  enlace_id: true,
  persona_id: true,
  periodo: true,
  monto_reportado: true,
  fecha_pago: true,
  medio: true,
  referencia: true,
  comentario: true,
  comprobante_nombre: true,
  comprobante_tipo: true,
  comprobante_tamano: true,
  estado: true,
  monto_aprobado: true,
  motivo_rechazo: true,
  cuenta_destino_id: true,
  transaccion_id: true,
  movimiento_id: true,
  revisado_at: true,
  created_at: true,
  persona: { select: { nombre: true } },
} satisfies Prisma.ReportesPagoPersonaSelect;

type Reporte = Prisma.ReportesPagoPersonaGetPayload<{ select: typeof SIN_COMPROBANTE }>;

/**
 * Pagos que las personas informan desde su enlace (con comprobante). El propietario los revisa: al APROBAR se registra el abono
 * en el sub-ledger (y, si indica la cuenta, el ingreso que mueve su saldo); al RECHAZAR queda el motivo y la deuda sigue igual.
 * Si el dinero ya llegó por correo del banco (ingreso de esa persona con el mismo monto), se sugiere enlazarlo en vez de duplicarlo.
 */
@Injectable()
export class ReportesPagoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enlaces: EnlacesCobroService,
  ) {}

  async listar(ownerUserId: bigint, filtro: FiltroReportesDto = {}) {
    const reportes = await this.prisma.reportesPagoPersona.findMany({
      where: { owner_user_id: ownerUserId, ...(filtro.estado ? { estado: filtro.estado } : {}), ...(filtro.periodo ? { periodo: filtro.periodo } : {}) },
      select: SIN_COMPROBANTE,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return Promise.all(reportes.map(async (r) => this.vista(r, r.estado === 'PENDIENTE' ? await this.correoCoincidente(r, ownerUserId) : null)));
  }

  async comprobante(id: number, ownerUserId: bigint) {
    const r = await this.prisma.reportesPagoPersona.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      select: { comprobante: true, comprobante_tipo: true, comprobante_nombre: true },
    });
    if (!r || !r.comprobante) throw new NotFoundException('El reporte no tiene comprobante');
    return { datos: Buffer.from(r.comprobante), tipo: r.comprobante_tipo ?? 'application/octet-stream', nombre: r.comprobante_nombre ?? 'comprobante' };
  }

  async aprobar(id: number, dto: AprobarReporteDto, ownerUserId: bigint) {
    const resultado = await this.prisma.$transaction(async (tx) => {
      const r = await this.pendiente(tx, id, ownerUserId);
      const monto = money(toDecimal(dto.monto ?? r.monto_reportado));
      if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });
      const concepto = `Pago reportado por ${r.persona.nombre ?? 'la persona'} (${r.periodo})`;
      const abono = await this.registrarAbono(tx, {
        ownerUserId,
        personaId: r.persona_id,
        periodo: r.periodo,
        monto,
        concepto,
        cuentaDestinoId: dto.cuentaDestinoId,
        transaccionId: dto.transaccionId,
      });
      await tx.reportesPagoPersona.update({
        where: { id: r.id },
        data: {
          estado: 'APROBADO',
          monto_aprobado: toDbMoney(monto),
          revisado_at: new Date(),
          cuenta_destino_id: abono.cuentaId,
          transaccion_id: abono.transaccionId,
          movimiento_id: abono.movimientoId,
        },
      });
      return { reporteId: r.id, personaId: r.persona_id, periodo: r.periodo, ...abono, monto };
    }, TX_OPTIONS);
    await this.enlaces.refrescarSiExiste(resultado.personaId, resultado.periodo, ownerUserId);
    return {
      reporteId: resultado.reporteId,
      estado: 'APROBADO' as const,
      monto: resultado.monto,
      movimientoId: resultado.movimientoId,
      transaccionId: resultado.transaccionId,
    };
  }

  async rechazar(id: number, dto: RechazarReporteDto, ownerUserId: bigint) {
    const r = await this.prisma.$transaction(async (tx) => {
      const p = await this.pendiente(tx, id, ownerUserId);
      return tx.reportesPagoPersona.update({
        where: { id: p.id },
        data: { estado: 'RECHAZADO', motivo_rechazo: dto.motivo.trim(), revisado_at: new Date() },
        select: SIN_COMPROBANTE,
      });
    }, TX_OPTIONS);
    await this.enlaces.refrescarSiExiste(r.persona_id, r.periodo, ownerUserId);
    return this.vista(r, null);
  }

  // ───────────────────────────── ingresos que ya llegaron ─────────────────────────────

  /**
   * Ingresos de tus cuentas (detectados por correo) que vienen de una persona registrada y aún no se han aplicado a su deuda:
   * «Alicia Buitrago te transfirió $2.000.000». Se aplican con `aplicarIngreso`.
   */
  async ingresosSugeridos(ownerUserId: bigint, periodo?: string) {
    const notas = await this.prisma.notificacionesCorreo.findMany({
      where: {
        owner_user_id: ownerUserId,
        persona_id: { not: null },
        transaccion_generada_id: { not: null },
        estado_procesamiento: { not: 'IGNORADO' },
        transaccion_generada: { is: { tipo_transaccion: TipoTransaccion.INGRESO, estado: { not: EstadoTransaccion.ANULADO } } },
      },
      select: { id: true, fecha_correo: true, persona_id: true, transaccion_generada_id: true, transaccion_generada: { select: { id: true, monto_cop: true, concepto: true, cuenta_destino_id: true } }, persona: { select: { nombre: true } } },
      orderBy: { fecha_correo: 'desc' },
      take: 100,
    });
    const txIds = notas.map((n) => n.transaccion_generada_id as bigint);
    const [usadosMov, usadosRep] = await Promise.all([
      this.prisma.movimientosDeudaPersona.findMany({ where: { owner_user_id: ownerUserId, transaccion_id: { in: txIds } }, select: { transaccion_id: true } }),
      this.prisma.reportesPagoPersona.findMany({ where: { owner_user_id: ownerUserId, transaccion_id: { in: txIds } }, select: { transaccion_id: true } }),
    ]);
    const usados = new Set([...usadosMov, ...usadosRep].map((x) => x.transaccion_id));
    return notas
      .filter((n) => !usados.has(n.transaccion_generada_id))
      .filter((n) => !periodo || periodoOf(n.fecha_correo) <= periodo)
      .map((n) => ({
        notificacionId: n.id,
        transaccionId: n.transaccion_generada_id,
        fecha: n.fecha_correo,
        personaId: n.persona_id,
        persona: n.persona?.nombre ?? null,
        monto: toDecimal(n.transaccion_generada?.monto_cop),
        concepto: n.transaccion_generada?.concepto ?? null,
        cuentaId: n.transaccion_generada?.cuenta_destino_id ?? null,
      }));
  }

  async aplicarIngreso(dto: AplicarIngresoDto, ownerUserId: bigint) {
    const r = await this.prisma.$transaction(async (tx) => {
      await assertPersona(tx, dto.personaId, ownerUserId);
      const persona = await tx.personas.findUniqueOrThrow({ where: { id: BigInt(dto.personaId) }, select: { nombre: true } });
      const t = await tx.transacciones.findFirst({ where: { id: BigInt(dto.transaccionId), owner_user_id: ownerUserId } });
      if (!t) throw new NotFoundException(`Transacción ${dto.transaccionId} no encontrada`);
      const monto = money(toDecimal(dto.monto ?? t.monto_cop));
      return this.registrarAbono(tx, {
        ownerUserId,
        personaId: BigInt(dto.personaId),
        periodo: dto.periodo,
        monto,
        concepto: `Pago recibido de ${persona.nombre ?? 'la persona'} (${dto.periodo})`,
        transaccionId: dto.transaccionId,
      }).then((abono) => ({ ...abono, monto }));
    }, TX_OPTIONS);
    await this.enlaces.refrescarSiExiste(BigInt(dto.personaId), dto.periodo, ownerUserId);
    return { movimientoId: r.movimientoId, transaccionId: r.transaccionId, monto: r.monto, personaId: dto.personaId, periodo: dto.periodo };
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async pendiente(tx: Tx, id: number, ownerUserId: bigint) {
    const r = await tx.reportesPagoPersona.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, select: SIN_COMPROBANTE });
    if (!r) throw new NotFoundException(`Reporte ${id} no encontrado`);
    if (r.estado !== 'PENDIENTE') throw new ConflictException(`El reporte ya fue ${r.estado.toLowerCase()}`);
    return r;
  }

  /**
   * Registra el abono de la persona. Tres caminos, del más al menos completo:
   *  • `transaccionId`  — el ingreso YA existe (p. ej. detectado por correo): solo se enlaza, no se crea otra transacción.
   *  • `cuentaDestinoId` — se registra el ingreso en esa cuenta (mueve el saldo) con `sp_registrar_abono_persona`.
   *  • ninguno          — solo se anota el abono (efectivo o dinero que no pasa por tus cuentas).
   */
  private async registrarAbono(
    tx: Tx,
    p: { ownerUserId: bigint; personaId: bigint; periodo: string; monto: ReturnType<typeof money>; concepto: string; cuentaDestinoId?: number; transaccionId?: number },
  ): Promise<{ movimientoId: bigint; transaccionId: bigint | null; cuentaId: bigint | null }> {
    if (p.transaccionId !== undefined && p.cuentaDestinoId !== undefined) {
      throw datosInvalidos({ transaccionId: ['Indica la transacción existente o la cuenta donde recibiste el dinero, pero no ambas'] });
    }

    if (p.transaccionId !== undefined) {
      const t = await tx.transacciones.findFirst({ where: { id: BigInt(p.transaccionId), owner_user_id: p.ownerUserId } });
      if (!t) throw new NotFoundException(`Transacción ${p.transaccionId} no encontrada`);
      if (t.tipo_transaccion !== TipoTransaccion.INGRESO || t.estado === EstadoTransaccion.ANULADO) {
        throw datosInvalidos({ transaccionId: ['Debe ser un ingreso vigente'] });
      }
      const [mov, rep] = await Promise.all([
        tx.movimientosDeudaPersona.findFirst({ where: { transaccion_id: t.id }, select: { id: true } }),
        tx.reportesPagoPersona.findFirst({ where: { transaccion_id: t.id }, select: { id: true } }),
      ]);
      if (mov || rep) throw new ConflictException('Ese ingreso ya se aplicó al pago de una persona');
      const m = await tx.movimientosDeudaPersona.create({
        data: {
          owner_user_id: p.ownerUserId,
          persona_id: p.personaId,
          fecha_movimiento: todayLocal(),
          periodo_imputacion: p.periodo,
          tipo_movimiento: TipoMovimientoDeuda.ABONO_PAGO_RECIBIDO,
          signo: -1,
          monto: toDbMoney(p.monto),
          transaccion_id: t.id,
          concepto: p.concepto.slice(0, 255),
          estado: EstadoMovimientoDeuda.CONFIRMADO,
        },
      });
      return { movimientoId: m.id, transaccionId: t.id, cuentaId: t.cuenta_destino_id };
    }

    if (p.cuentaDestinoId !== undefined) {
      await assertCuenta(tx, p.cuentaDestinoId, p.ownerUserId);
      const filas = await tx.$queryRaw<Array<{ movimiento_id: bigint }>>`
        SELECT sp_registrar_abono_persona(
          ${p.ownerUserId}::int8, ${p.personaId}::int8, ${BigInt(p.cuentaDestinoId)}::int8,
          ${toDbMoney(p.monto)}::numeric(15,2), ${p.periodo}::char(7), ${p.concepto.slice(0, 255)}::varchar, ${null}::int8
        ) AS movimiento_id`;
      const movimientoId = filas[0].movimiento_id;
      const m = await tx.movimientosDeudaPersona.findUniqueOrThrow({ where: { id: movimientoId }, select: { transaccion_id: true } });
      return { movimientoId, transaccionId: m.transaccion_id, cuentaId: BigInt(p.cuentaDestinoId) };
    }

    const m = await tx.movimientosDeudaPersona.create({
      data: {
        owner_user_id: p.ownerUserId,
        persona_id: p.personaId,
        fecha_movimiento: todayLocal(),
        periodo_imputacion: p.periodo,
        tipo_movimiento: TipoMovimientoDeuda.ABONO_PAGO_RECIBIDO,
        signo: -1,
        monto: toDbMoney(p.monto),
        concepto: p.concepto.slice(0, 255),
        estado: EstadoMovimientoDeuda.CONFIRMADO,
      },
    });
    return { movimientoId: m.id, transaccionId: null, cuentaId: null };
  }

  /** ¿Ya llegó a tus cuentas un ingreso de esta persona por este monto (±1 día de la fecha que dice)? */
  private async correoCoincidente(r: Reporte, ownerUserId: bigint) {
    const desde = new Date(r.fecha_pago.getTime() - 3 * 86_400_000);
    const hasta = new Date(r.fecha_pago.getTime() + 8 * 86_400_000);
    const n = await this.prisma.notificacionesCorreo.findFirst({
      where: {
        owner_user_id: ownerUserId,
        persona_id: r.persona_id,
        transaccion_generada_id: { not: null },
        fecha_correo: { gte: desde, lte: hasta },
        transaccion_generada: { is: { tipo_transaccion: TipoTransaccion.INGRESO, estado: { not: EstadoTransaccion.ANULADO }, monto_cop: r.monto_reportado } },
      },
      select: { id: true, fecha_correo: true, transaccion_generada_id: true, transaccion_generada: { select: { monto_cop: true, cuenta_destino_id: true } } },
      orderBy: { fecha_correo: 'asc' },
    });
    if (!n) return null;
    const usado =
      (await this.prisma.movimientosDeudaPersona.count({ where: { transaccion_id: n.transaccion_generada_id } })) +
      (await this.prisma.reportesPagoPersona.count({ where: { transaccion_id: n.transaccion_generada_id } }));
    if (usado > 0) return null;
    return {
      notificacionId: n.id,
      transaccionId: n.transaccion_generada_id,
      fecha: n.fecha_correo,
      monto: toDecimal(n.transaccion_generada?.monto_cop),
      cuentaId: n.transaccion_generada?.cuenta_destino_id ?? null,
    };
  }

  private vista(r: Reporte, correo: Awaited<ReturnType<ReportesPagoService['correoCoincidente']>>) {
    return {
      id: r.id,
      enlaceId: r.enlace_id,
      personaId: r.persona_id,
      persona: r.persona.nombre,
      periodo: r.periodo,
      montoReportado: toDecimal(r.monto_reportado),
      fechaPago: r.fecha_pago,
      medio: r.medio,
      referencia: r.referencia,
      comentario: r.comentario,
      tieneComprobante: r.comprobante_tamano !== null,
      comprobanteNombre: r.comprobante_nombre,
      comprobanteTipo: r.comprobante_tipo,
      comprobanteTamano: r.comprobante_tamano,
      estado: r.estado,
      montoAprobado: r.monto_aprobado === null ? null : toDecimal(r.monto_aprobado),
      motivoRechazo: r.motivo_rechazo,
      revisadoEn: r.revisado_at,
      creadoEn: r.created_at,
      transaccionId: r.transaccion_id,
      movimientoId: r.movimiento_id,
      /** El dinero ya aparece en tus cuentas (por correo del banco): se puede aprobar enlazándolo. */
      correoCoincidente: correo,
    };
  }
}
