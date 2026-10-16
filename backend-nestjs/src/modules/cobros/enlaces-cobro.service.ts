import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isValidPeriodo } from '../../common/utils/date.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertPersona } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { LiquidacionMensualService } from '../liquidacion-mensual/liquidacion-mensual.service';
import { FiltroEnlacesDto, GenerarEnlaceDto } from './dto/cobros.dto';

const DIAS_POR_DEFECTO = 45;
const DIAS_MAXIMOS = 180;
const MS_DIA = 86_400_000;

export const TITULOS_BLOQUES: Array<[string, string]> = [
  ['cuotasTarjetas', 'Compras con tarjeta de crédito'],
  ['cuotasPrestamos', 'Préstamos'],
  ['cargosRecurrentes', 'Cobros recurrentes'],
  ['cobrosPuntuales', 'Servicios, mercado y eventos del mes'],
  ['crucesCuentas', 'Cruces de cuentas'],
  ['saldoAFavorAplicado', 'Saldo a favor aplicado'],
  ['abonosRealizados', 'Pagos y abonos'],
  ['otros', 'Otros'],
];

export interface SnapshotCobro {
  version: 1;
  periodo: string;
  generadoEn: string;
  propietario: { nombre: string | null };
  persona: { nombre: string | null; iniciales: string | null; color: string | null };
  bloques: Array<{
    clave: string;
    titulo: string;
    subtotal: number;
    items: Array<{ fecha: string; concepto: string; monto: number; signo: number; impacto: number; origen: string; detalle: unknown }>;
  }>;
  /** Faltante de la cuota del carro u otras obligaciones del mes. */
  obligaciones: Array<{ concepto: string; metaMensual: number; montoAbonado: number; saldoPendiente: number }>;
  resumen: {
    totalCargos: number;
    totalAbonosYFavor: number;
    saldoNetoFinal: number;
    estado: string;
    saldoAnterior: number;
    saldoTotalAcumulado: number;
  };
}

const num = (d: { toNumber(): number } | null | undefined): number => (d ? d.toNumber() : 0);
const dia = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Enlaces para compartir con cada persona el detalle de lo que debe en un mes. El enlace guarda una FOTO de la liquidación
 * (lo que ella ve es exactamente lo que se revisó al generarlo) y se actualiza cuando el propietario lo pide o cuando aprueba un pago.
 */
@Injectable()
export class EnlacesCobroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liquidacion: LiquidacionMensualService,
  ) {}

  async generar(dto: GenerarEnlaceDto, ownerUserId: bigint) {
    if (!isValidPeriodo(dto.periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    const dias = dto.diasVigencia ?? DIAS_POR_DEFECTO;
    if (dias < 1 || dias > DIAS_MAXIMOS) throw datosInvalidos({ diasVigencia: [`diasVigencia debe estar entre 1 y ${DIAS_MAXIMOS}`] });
    await assertPersona(this.prisma, dto.personaId, ownerUserId);

    const snapshot = await this.construirSnapshot(dto.periodo, dto.personaId, ownerUserId);
    const expira = new Date(Date.now() + dias * MS_DIA);
    const clave = { owner_user_id_persona_id_periodo: { owner_user_id: ownerUserId, persona_id: BigInt(dto.personaId), periodo: dto.periodo } };
    const existente = await this.prisma.enlacesCobroPersona.findUnique({ where: clave });

    const enlace = existente
      ? await this.prisma.enlacesCobroPersona.update({
          where: { id: existente.id },
          data: {
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            snapshot_at: new Date(),
            ...(dto.mensaje !== undefined ? { mensaje: dto.mensaje.trim() || null } : {}),
            ...(dto.instruccionesPago !== undefined ? { instrucciones_pago: dto.instruccionesPago.trim() || null } : {}),
            expira_at: expira,
            revocado: false,
            ...(dto.rotarToken ? { token: this.nuevoToken(), vistas: 0, ultima_vista_at: null } : {}),
            updated_at: new Date(),
          },
          include: { persona: { select: { nombre: true } } },
        })
      : await this.prisma.enlacesCobroPersona.create({
          data: {
            owner_user_id: ownerUserId,
            persona_id: BigInt(dto.personaId),
            periodo: dto.periodo,
            token: this.nuevoToken(),
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            mensaje: dto.mensaje?.trim() || null,
            instrucciones_pago: dto.instruccionesPago?.trim() || null,
            expira_at: expira,
          },
          include: { persona: { select: { nombre: true } } },
        });
    return this.vista(enlace, 0);
  }

  async listar(ownerUserId: bigint, filtro: FiltroEnlacesDto = {}) {
    const enlaces = await this.prisma.enlacesCobroPersona.findMany({
      where: { owner_user_id: ownerUserId, ...(filtro.periodo ? { periodo: filtro.periodo } : {}) },
      include: { persona: { select: { nombre: true } } },
      orderBy: [{ periodo: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    const pendientes = await this.prisma.reportesPagoPersona.groupBy({
      by: ['enlace_id'],
      where: { owner_user_id: ownerUserId, estado: 'PENDIENTE', enlace_id: { in: enlaces.map((e) => e.id) } },
      _count: true,
    });
    const porEnlace = new Map(pendientes.map((p) => [p.enlace_id, p._count]));
    return enlaces.map((e) => this.vista(e, porEnlace.get(e.id) ?? 0));
  }

  async refrescar(id: number, ownerUserId: bigint) {
    const e = await this.requerir(id, ownerUserId);
    return this.actualizarSnapshot(e.id, e.periodo, e.persona_id, ownerUserId);
  }

  /** Tras aprobar un pago: la persona ve su saldo al día en el mismo enlace. Si no hay enlace, no hace nada. */
  async refrescarSiExiste(personaId: bigint, periodo: string, ownerUserId: bigint): Promise<void> {
    const e = await this.prisma.enlacesCobroPersona.findFirst({ where: { owner_user_id: ownerUserId, persona_id: personaId, periodo }, select: { id: true } });
    if (e) await this.actualizarSnapshot(e.id, periodo, personaId, ownerUserId);
  }

  async revocar(id: number, ownerUserId: bigint) {
    const e = await this.requerir(id, ownerUserId);
    const r = await this.prisma.enlacesCobroPersona.update({ where: { id: e.id }, data: { revocado: true, updated_at: new Date() }, include: { persona: { select: { nombre: true } } } });
    return this.vista(r, 0);
  }

  // ───────────────────────────── internos ─────────────────────────────

  private nuevoToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private async requerir(id: number, ownerUserId: bigint) {
    const e = await this.prisma.enlacesCobroPersona.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!e) throw new NotFoundException(`Enlace ${id} no encontrado`);
    return e;
  }

  private async actualizarSnapshot(id: bigint, periodo: string, personaId: bigint, ownerUserId: bigint) {
    const snapshot = await this.construirSnapshot(periodo, Number(personaId), ownerUserId);
    const e = await this.prisma.enlacesCobroPersona.update({
      where: { id },
      data: { snapshot: snapshot as unknown as Prisma.InputJsonValue, snapshot_at: new Date(), updated_at: new Date() },
      include: { persona: { select: { nombre: true } } },
    });
    const pendientes = await this.prisma.reportesPagoPersona.count({ where: { enlace_id: id, estado: 'PENDIENTE' } });
    return this.vista(e, pendientes);
  }

  /** Lo que ve la persona: solo SU liquidación del periodo, sin identificadores internos ni datos de otras personas. */
  async construirSnapshot(periodo: string, personaId: number, ownerUserId: bigint): Promise<SnapshotCobro> {
    const liq = await this.liquidacion.liquidacionPersona(periodo, personaId, ownerUserId);
    const propietario = await this.prisma.users.findUnique({ where: { id: ownerUserId }, select: { name: true } });
    const bloques = TITULOS_BLOQUES.map(([clave, titulo]) => {
      const b = (liq as unknown as Record<string, { items: Array<Record<string, any>>; subtotal: { toNumber(): number } }>)[clave]; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        clave,
        titulo,
        subtotal: num(b.subtotal),
        items: b.items.map((i) => ({
          fecha: dia(i.fecha as Date),
          concepto: String(i.concepto),
          monto: num(i.monto),
          signo: Number(i.signo),
          impacto: num(i.impacto),
          origen: String(i.origen),
          detalle: this.detallePublico(i.detalle),
        })),
      };
    }).filter((b) => b.items.length > 0);

    return {
      version: 1,
      periodo,
      generadoEn: new Date().toISOString(),
      propietario: { nombre: propietario?.name ?? null },
      persona: { nombre: liq.persona.nombre, iniciales: liq.persona.iniciales, color: liq.persona.color },
      bloques,
      obligaciones: liq.obligaciones
        .filter((o) => o.saldoPendiente.greaterThan(0) || o.montoAbonado.greaterThan(0))
        .map((o) => ({ concepto: o.concepto, metaMensual: num(o.valorCuotaObjetivo), montoAbonado: num(o.montoAbonado), saldoPendiente: num(o.saldoPendiente) })),
      resumen: {
        totalCargos: num(liq.resumenNeto.totalCargos),
        totalAbonosYFavor: num(liq.resumenNeto.totalAbonosYFavor),
        saldoNetoFinal: num(liq.resumenNeto.saldoNetoFinal),
        estado: liq.resumenNeto.estado,
        saldoAnterior: num(liq.saldoAnterior),
        saldoTotalAcumulado: num(liq.saldoTotalAcumulado),
      },
    };
  }

  /** Convierte los Decimal/Date del detalle a valores JSON simples. */
  private detallePublico(detalle: unknown): unknown {
    if (!detalle || typeof detalle !== 'object') return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detalle as Record<string, unknown>)) {
      if (v instanceof Date) out[k] = dia(v);
      else if (v && typeof v === 'object' && 'toNumber' in v) out[k] = (v as { toNumber(): number }).toNumber();
      else out[k] = v;
    }
    return out;
  }

  private vista(e: { id: bigint; persona_id: bigint; periodo: string; token: string; snapshot: Prisma.JsonValue; snapshot_at: Date; mensaje: string | null; instrucciones_pago: string | null; expira_at: Date; revocado: boolean; vistas: number; ultima_vista_at: Date | null; persona: { nombre: string | null } }, pendientes: number) {
    const snap = e.snapshot as unknown as SnapshotCobro;
    return {
      id: e.id,
      personaId: e.persona_id,
      persona: e.persona.nombre,
      periodo: e.periodo,
      token: e.token,
      ruta: `/p/${e.token}`,
      mensaje: e.mensaje,
      instruccionesPago: e.instrucciones_pago,
      expiraEn: e.expira_at,
      revocado: e.revocado,
      vigente: !e.revocado && e.expira_at.getTime() > Date.now(),
      vistas: e.vistas,
      ultimaVistaEn: e.ultima_vista_at,
      snapshotEn: e.snapshot_at,
      resumen: snap?.resumen ?? null,
      reportesPendientes: pendientes,
    };
  }
}
