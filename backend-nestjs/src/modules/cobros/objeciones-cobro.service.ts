import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoMovimientoDeuda, TipoMovimientoDeuda } from '../../common/enums/finance.enums';
import { todayLocal } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { asegurarClaves, buscarItem, conceptoDeAjuste, descuentoDeResolucion } from './ajustes-cobro.util';
import { DescuentoDirectoDto, FiltroObjecionesDto, ObjetarCobroDto, ResolverObjecionDto } from './dto/cobros-fase6.dto';
import { EnlacesCobroService, SnapshotCobro } from './enlaces-cobro.service';

/** Observaciones abiertas que una persona puede tener a la vez en un enlace (evita que el formulario público se use para llenar la base). */
export const MAX_OBJECIONES_ABIERTAS = 20;

type Objecion = Prisma.ObjecionesCobroGetPayload<{ include: { persona: { select: { nombre: true } } } }>;

/**
 * Observaciones de la persona sobre su cobro y su resolución por el propietario.
 *
 * Un ajuste NO modifica las compras ni los préstamos de origen: se registra como un asiento `AJUSTE_DESCUENTO` (abono) en el libro de
 * deudas de la persona. Así el saldo baja en todas las pantallas, queda trazado y se puede deshacer anulando ese asiento.
 */
@Injectable()
export class ObjecionesCobroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enlaces: EnlacesCobroService,
  ) {}

  // ───────────────────────────── lado público ─────────────────────────────

  async crear(enlace: { id: bigint; owner_user_id: bigint; persona_id: bigint; periodo: string; snapshot: Prisma.JsonValue }, dto: ObjetarCobroDto) {
    const comentario = dto.comentario.trim();
    if (comentario.length < 3) throw datosInvalidos({ comentario: ['Cuéntanos qué pasa con este cobro (mínimo 3 letras)'] });
    const abiertas = await this.prisma.objecionesCobro.count({ where: { enlace_id: enlace.id, estado: 'ABIERTA' } });
    if (abiertas >= MAX_OBJECIONES_ABIERTAS) {
      throw new HttpException({ message: 'Ya tienes varias observaciones esperando respuesta. Espera a que te las contesten antes de enviar otra.' }, HttpStatus.CONFLICT);
    }

    let itemClave: string | null = null;
    let itemConcepto: string | null = null;
    let itemMonto: Decimal | null = null;
    if (dto.alcance === 'ITEM') {
      if (!dto.itemClave) throw datosInvalidos({ itemClave: ['Indica cuál cobro quieres observar'] });
      const snapshot = asegurarClaves(enlace.snapshot as unknown as SnapshotCobro);
      const item = buscarItem(snapshot, dto.itemClave);
      if (!item) throw datosInvalidos({ itemClave: ['Ese cobro ya no aparece en tu resumen. Recarga la página.'] });
      itemClave = item.clave;
      itemConcepto = item.concepto.slice(0, 255);
      itemMonto = money(new Decimal(item.impacto));
    }
    const propuesto = dto.montoPropuesto === undefined ? null : money(toDecimal(dto.montoPropuesto));
    if (propuesto && propuesto.isNegative()) throw datosInvalidos({ montoPropuesto: ['El monto no puede ser negativo'] });

    const o = await this.prisma.objecionesCobro.create({
      data: {
        owner_user_id: enlace.owner_user_id,
        enlace_id: enlace.id,
        persona_id: enlace.persona_id,
        periodo: enlace.periodo,
        alcance: dto.alcance,
        item_clave: itemClave,
        item_concepto: itemConcepto,
        item_monto: itemMonto === null ? null : toDbMoney(itemMonto),
        comentario,
        monto_propuesto: propuesto === null ? null : toDbMoney(propuesto),
      },
      include: { persona: { select: { nombre: true } } },
    });
    return { ...this.vistaPublica(o), mensaje: 'Recibimos tu observación. Quien te cobra la revisará y te responderá aquí mismo.' };
  }

  async deLaPersona(enlaceId: bigint) {
    const filas = await this.prisma.objecionesCobro.findMany({
      where: { enlace_id: enlaceId },
      include: { persona: { select: { nombre: true } } },
      orderBy: { id: 'desc' },
      take: 30,
    });
    return filas.map((o) => this.vistaPublica(o));
  }

  // ───────────────────────────── propietario ─────────────────────────────

  async listar(ownerUserId: bigint, filtro: FiltroObjecionesDto = {}) {
    const filas = await this.prisma.objecionesCobro.findMany({
      where: { owner_user_id: ownerUserId, ...(filtro.estado ? { estado: filtro.estado } : {}), ...(filtro.periodo ? { periodo: filtro.periodo } : {}) },
      include: { persona: { select: { nombre: true } } },
      orderBy: [{ estado: 'asc' }, { created_at: 'desc' }],
      take: 200,
    });
    return filas.map((o) => this.vistaAdmin(o));
  }

  async resolver(id: number, dto: ResolverObjecionDto, ownerUserId: bigint) {
    const o = await this.requerir(id, ownerUserId);
    if (o.estado !== 'ABIERTA') throw new ConflictException('Esta observación ya fue resuelta');
    const respuesta = dto.respuesta?.trim() || null;
    if (dto.accion === 'MANTENER' && (!respuesta || respuesta.length < 3)) {
      throw datosInvalidos({ respuesta: ['Explícale a la persona por qué se mantiene el cobro'] });
    }
    if ((dto.accion === 'AJUSTAR' || dto.accion === 'EXCLUIR') && o.alcance !== 'ITEM') {
      throw datosInvalidos({ accion: ['Para ajustar o excluir elige una observación sobre un cobro; sobre el total usa «Descuento»'] });
    }

    const itemMonto = o.item_monto === null ? null : toDecimal(o.item_monto);
    const saldo = dto.accion === 'DESCUENTO' ? await this.saldoPendiente(o.persona_id, o.periodo, ownerUserId) : null;
    const descuento = descuentoDeResolucion({ accion: dto.accion, monto: dto.monto, itemMonto, saldoPendiente: saldo });

    const resuelta = await this.prisma.$transaction(async (tx) => {
      let movimientoId: bigint | null = null;
      if (descuento) {
        movimientoId = await this.crearAsiento(tx, {
          ownerUserId,
          personaId: o.persona_id,
          periodo: o.periodo,
          descuento,
          concepto: conceptoDeAjuste({ accion: dto.accion, itemConcepto: o.item_concepto, itemMonto, descuento, motivo: respuesta ?? o.comentario }),
        });
      }
      return tx.objecionesCobro.update({
        where: { id: o.id },
        data: {
          estado: 'RESUELTA',
          resolucion: { MANTENER: 'MANTENIDA', AJUSTAR: 'AJUSTADA', EXCLUIR: 'EXCLUIDA', DESCUENTO: 'DESCUENTO' }[dto.accion],
          respuesta,
          monto_ajuste: descuento ? toDbMoney(descuento) : null,
          movimiento_id: movimientoId,
          resuelta_at: new Date(),
        },
        include: { persona: { select: { nombre: true } } },
      });
    }, TX_OPTIONS);

    // la persona ve su total recalculado en el mismo enlace
    const enlace = await this.enlaces.refrescar(Number(o.enlace_id), ownerUserId);
    return { objecion: this.vistaAdmin(resuelta), descuento, enlace };
  }

  /** Descuento directo sobre el saldo de una persona (sin que haya una observación): también queda como asiento y se puede deshacer. */
  async descuentoDirecto(enlaceId: number, dto: DescuentoDirectoDto, ownerUserId: bigint) {
    const e = await this.prisma.enlacesCobroPersona.findFirst({ where: { id: BigInt(enlaceId), owner_user_id: ownerUserId }, select: { id: true, persona_id: true, periodo: true } });
    if (!e) throw new NotFoundException(`Enlace ${enlaceId} no encontrado`);
    const saldo = await this.saldoPendiente(e.persona_id, e.periodo, ownerUserId);
    const descuento = descuentoDeResolucion({ accion: 'DESCUENTO', monto: dto.monto, itemMonto: null, saldoPendiente: saldo });
    if (!descuento) throw datosInvalidos({ monto: ['El descuento debe ser mayor a 0'] });
    const movimientoId = await this.prisma.$transaction(
      (tx) => this.crearAsiento(tx, { ownerUserId, personaId: e.persona_id, periodo: e.periodo, descuento, concepto: conceptoDeAjuste({ accion: 'DESCUENTO', itemConcepto: null, itemMonto: null, descuento, motivo: dto.motivo }) }),
      TX_OPTIONS,
    );
    const enlace = await this.enlaces.refrescar(enlaceId, ownerUserId);
    return { movimientoId, descuento, enlace };
  }

  /** Descuentos y ajustes vigentes de un enlace (para poder deshacerlos). */
  async ajustes(enlaceId: number, ownerUserId: bigint) {
    const e = await this.prisma.enlacesCobroPersona.findFirst({ where: { id: BigInt(enlaceId), owner_user_id: ownerUserId }, select: { persona_id: true, periodo: true } });
    if (!e) throw new NotFoundException(`Enlace ${enlaceId} no encontrado`);
    const movs = await this.prisma.movimientosDeudaPersona.findMany({
      where: { owner_user_id: ownerUserId, persona_id: e.persona_id, periodo_imputacion: e.periodo, tipo_movimiento: TipoMovimientoDeuda.AJUSTE_DESCUENTO, OR: [{ estado: null }, { estado: { not: EstadoMovimientoDeuda.ANULADO } }] },
      select: { id: true, monto: true, concepto: true, fecha_movimiento: true },
      orderBy: { id: 'desc' },
    });
    const ligadas = await this.prisma.objecionesCobro.findMany({ where: { movimiento_id: { in: movs.map((m) => m.id) } }, select: { id: true, movimiento_id: true } });
    const porMov = new Map(ligadas.map((l) => [l.movimiento_id, l.id]));
    return movs.map((m) => ({ movimientoId: m.id, monto: toDecimal(m.monto), concepto: m.concepto, fecha: m.fecha_movimiento, objecionId: porMov.get(m.id) ?? null }));
  }

  /** Anula un descuento: la persona vuelve a deber ese monto y, si resolvía una observación, esta vuelve a quedar abierta. */
  async deshacerAjuste(movimientoId: number, ownerUserId: bigint) {
    const m = await this.prisma.movimientosDeudaPersona.findFirst({
      where: { id: BigInt(movimientoId), owner_user_id: ownerUserId, tipo_movimiento: TipoMovimientoDeuda.AJUSTE_DESCUENTO, OR: [{ estado: null }, { estado: { not: EstadoMovimientoDeuda.ANULADO } }] },
      select: { id: true, persona_id: true, periodo_imputacion: true },
    });
    if (!m) throw new NotFoundException(`Ajuste ${movimientoId} no encontrado o ya deshecho`);
    await this.prisma.$transaction(async (tx) => {
      await tx.movimientosDeudaPersona.update({ where: { id: m.id }, data: { estado: EstadoMovimientoDeuda.ANULADO } });
      await tx.objecionesCobro.updateMany({
        where: { movimiento_id: m.id },
        data: { estado: 'ABIERTA', resolucion: null, respuesta: null, monto_ajuste: null, movimiento_id: null, resuelta_at: null },
      });
    }, TX_OPTIONS);
    if (m.periodo_imputacion) await this.enlaces.refrescarSiExiste(m.persona_id, m.periodo_imputacion, ownerUserId);
    return { deshecho: true as const, movimientoId: m.id };
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async requerir(id: number, ownerUserId: bigint) {
    const o = await this.prisma.objecionesCobro.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, include: { persona: { select: { nombre: true } } } });
    if (!o) throw new NotFoundException(`Observación ${id} no encontrada`);
    return o;
  }

  /** Lo que la persona debe hoy (lo del mes más lo que arrastra), con la liquidación recién calculada. */
  private async saldoPendiente(personaId: bigint, periodo: string, ownerUserId: bigint): Promise<Decimal> {
    const snap = await this.enlaces.construirSnapshot(periodo, Number(personaId), ownerUserId);
    const saldo = money(new Decimal(snap.resumen.saldoTotalAcumulado));
    if (!saldo.greaterThan(0)) throw new ConflictException('Esta persona no debe nada: no hay saldo al que aplicar un descuento');
    return saldo;
  }

  private async crearAsiento(tx: Prisma.TransactionClient, p: { ownerUserId: bigint; personaId: bigint; periodo: string; descuento: Decimal; concepto: string }): Promise<bigint> {
    const m = await tx.movimientosDeudaPersona.create({
      data: {
        owner_user_id: p.ownerUserId,
        persona_id: p.personaId,
        fecha_movimiento: todayLocal(),
        periodo_imputacion: p.periodo,
        tipo_movimiento: TipoMovimientoDeuda.AJUSTE_DESCUENTO,
        signo: -1,
        monto: toDbMoney(p.descuento),
        concepto: p.concepto.slice(0, 255),
        estado: EstadoMovimientoDeuda.CONFIRMADO,
      },
      select: { id: true },
    });
    return m.id;
  }

  private vistaPublica(o: Objecion) {
    return {
      id: o.id,
      alcance: o.alcance,
      concepto: o.alcance === 'ITEM' ? o.item_concepto : null,
      monto: o.item_monto === null ? null : toDecimal(o.item_monto),
      comentario: o.comentario,
      montoPropuesto: o.monto_propuesto === null ? null : toDecimal(o.monto_propuesto),
      estado: o.estado,
      resolucion: o.resolucion,
      respuesta: o.respuesta,
      montoAjuste: o.monto_ajuste === null ? null : toDecimal(o.monto_ajuste),
      creadaEn: o.created_at,
      resueltaEn: o.resuelta_at,
    };
  }

  private vistaAdmin(o: Objecion) {
    return {
      ...this.vistaPublica(o),
      enlaceId: o.enlace_id,
      personaId: o.persona_id,
      persona: o.persona.nombre,
      periodo: o.periodo,
      itemClave: o.item_clave,
      movimientoId: o.movimiento_id,
    };
  }
}
