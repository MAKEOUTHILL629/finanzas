import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoAprobacion, EstadoPrestamo } from '../../common/enums/finance.enums';
import { parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, toDb, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { dateToMillis, idNum, num, numOrNull, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePrestamoDto,
  PrestamosFiltroDto,
  ResolverAprobacionDto,
  ResolverAprobacionPorPersonaDto,
  UpdatePrestamoDto,
} from './dto/prestamo.dto';

type Tx = Prisma.TransactionClient;

/**
 * Préstamos (legacy `PrestamoRepositorio` + extensión ERP v2).
 * El Trigger 4 (`trg_sync_prestamo_subledger`) crea el cargo (+1) al insertar y el abono (-1) al pasar a 'Pagado':
 * este servicio NUNCA inserta en `MovimientosDeudaPersona`.
 */
@Injectable()
export class PrestamosService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── legacy ─────────────────────────────

  /**
   * `GET /api/prestamos` — JSON de `Json.writes[Prestamo]` (campos legacy intactos) + columnas del esquema Supabase y las
   * aprobaciones (superconjunto: Angular ignora lo que no conoce). Filtros opcionales: estado, direccion, corteId, responsableId.
   */
  async listLegacy(ownerUserId: bigint, filtro: PrestamosFiltroDto = {}) {
    const prestamos = await this.prisma.prestamos.findMany({
      where: {
        owner_user_id: ownerUserId,
        ...(filtro.estado ? { estado: filtro.estado } : {}),
        ...(filtro.direccion ? { direccion_prestamo: filtro.direccion } : {}),
        ...(filtro.corteId ? { corte_id: BigInt(filtro.corteId) } : {}),
        ...(filtro.responsableId ? { responsable: BigInt(filtro.responsableId) } : {}),
      },
      include: { aprobaciones: { include: { persona: { select: { nombre: true } } }, orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    return prestamos.map((p) => this.toJson(p));
  }

  /** `POST /api/prestamos`. Devuelve el id creado. */
  async create(dto: CreatePrestamoDto, ownerUserId: bigint): Promise<number> {
    return this.prisma.$transaction((tx) => this.createTx(tx, dto, ownerUserId));
  }

  /** Versión transaccional (la usa también la conciliación de correos al convertir un egreso en préstamo). */
  async createTx(tx: Tx, dto: CreatePrestamoDto, ownerUserId: bigint): Promise<number> {
    const valor = money(toDecimal(dto.valorPrestado));
    if (!valor.greaterThan(0)) throw datosInvalidos({ valorPrestado: ['valorPrestado debe ser mayor a 0'] });
    const fechaCobro = parseIsoDate(dto.fechaCobro.slice(0, 10));
    if (!fechaCobro) throw datosInvalidos({ fechaCobro: ['fechaCobro debe tener formato yyyy-MM-dd'] });
    const fechaPrestamo = dto.fechaPrestamo ? parseIsoDate(dto.fechaPrestamo) : todayLocal();
    if (!fechaPrestamo) throw datosInvalidos({ fechaPrestamo: ['fechaPrestamo debe tener formato yyyy-MM-dd'] });

    const persona = await tx.personas.findFirst({
      where: { id: BigInt(dto.responsable), owner_user_id: ownerUserId },
      select: { id: true },
    });
    if (!persona) throw new Error(`No se encontró la persona con ID ${dto.responsable}`);

    const corteId = dto.corteId
      ? await this.requireCorte(tx, dto.corteId, ownerUserId)
      : await this.corteParaFecha(tx, ownerUserId, fechaPrestamo);
    const miPersona = await tx.personas.findFirst({
      where: { linked_user_id: ownerUserId },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    const creado = await tx.prestamos.create({
      data: {
        owner_user_id: ownerUserId,
        valor_prestado: toDbMoney(valor),
        concepto: dto.concepto,
        fecha_cobro: fechaCobro,
        responsable: persona.id,
        estado: dto.estado,
        comentarios: dto.comentarios,
        direccion_prestamo: dto.direccionPrestamo ?? 'POR_COBRAR',
        saldo_pendiente: toDbMoney(valor),
        es_recurrente_mensual: dto.esRecurrenteMensual ?? false,
        cuota_mensual_acordada:
          dto.cuotaMensualAcordada === undefined ? null : toDbMoney(toDecimal(dto.cuotaMensualAcordada)),
        fecha_prestamo: fechaPrestamo,
        metodo: dto.metodo ?? null,
        corte_id: corteId,
        creado_por_persona_id: miPersona?.id ?? null,
      },
    });
    return idNum(creado.id);
  }

  // ───────────────────────────── detalle y edición ─────────────────────────────

  async get(id: number, ownerUserId: bigint) {
    const prestamo = await this.prisma.prestamos.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      include: { aprobaciones: { include: { persona: { select: { nombre: true } } }, orderBy: { id: 'asc' } } },
    });
    if (!prestamo) throw new NotFoundException(`Préstamo ${id} no encontrado`);
    return this.toJson(prestamo);
  }

  async update(id: number, dto: UpdatePrestamoDto, ownerUserId: bigint) {
    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.prestamos.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Préstamo ${id} no encontrado`);

      const data: Prisma.PrestamosUncheckedUpdateInput = {};
      if (dto.comentarios !== undefined) data.comentarios = dto.comentarios;
      if (dto.metodo !== undefined) data.metodo = dto.metodo;
      if (dto.corteId !== undefined) data.corte_id = await this.requireCorte(tx, dto.corteId, ownerUserId);
      if (dto.fechaCobro !== undefined) {
        const fecha = parseIsoDate(dto.fechaCobro);
        if (!fecha) throw datosInvalidos({ fechaCobro: ['fechaCobro debe tener formato yyyy-MM-dd'] });
        data.fecha_cobro = fecha;
      }
      if (dto.saldoPendiente !== undefined) {
        const saldo = money(toDecimal(dto.saldoPendiente));
        if (saldo.isNegative()) throw datosInvalidos({ saldoPendiente: ['saldoPendiente no puede ser negativo'] });
        data.saldo_pendiente = toDbMoney(saldo);
      }

      const pagando = dto.estado === EstadoPrestamo.PAGADO && (actual.estado ?? '').toLowerCase() !== 'pagado';
      if (dto.estado !== undefined) data.estado = dto.estado;

      if (Object.keys(data).length > 0) {
        await tx.prestamos.update({ where: { id: actual.id }, data });
      }
      // El Trigger 4 abona COALESCE(saldo_pendiente, valor_prestado) al cambiar a 'Pagado'; recién DESPUÉS se pone el
      // saldo en 0 (en otro UPDATE) para que el asiento no quede en monto 0.
      if (pagando && dto.saldoPendiente === undefined) {
        await tx.prestamos.update({ where: { id: actual.id }, data: { saldo_pendiente: toDb(toDecimal(0)) } });
      }
    });
    return this.get(id, ownerUserId);
  }

  async listAprobaciones(prestamoId: number, ownerUserId: bigint) {
    await this.get(prestamoId, ownerUserId);
    const aprobaciones = await this.prisma.aprobacionesPrestamos.findMany({
      where: { prestamo_id: BigInt(prestamoId) },
      include: { persona: { select: { nombre: true } } },
      orderBy: { id: 'asc' },
    });
    return aprobaciones.map((a) => this.aprobacionJson(a));
  }

  /**
   * Aprobar/rechazar. Puede hacerlo el dueño del libro (administrador), un usuario ADMIN o la persona que tiene
   * enlazado (`Personas.linked_user_id`) al usuario autenticado.
   */
  async resolverAprobacion(
    prestamoId: number,
    aprobacionId: number,
    dto: ResolverAprobacionDto,
    user: AuthenticatedUser,
  ) {
    if (dto.estado === EstadoAprobacion.PENDIENTE) {
      throw datosInvalidos({ estado: ['estado debe ser Aprobado o Rechazado'] });
    }
    const aprobacion = await this.prisma.aprobacionesPrestamos.findFirst({
      where: { id: BigInt(aprobacionId), prestamo_id: BigInt(prestamoId) },
      include: { prestamo: { select: { owner_user_id: true } }, persona: { select: { linked_user_id: true } } },
    });
    if (!aprobacion) throw new NotFoundException(`Aprobación ${aprobacionId} no encontrada`);

    const esDueno = aprobacion.prestamo.owner_user_id === user.userId;
    const esLaPersona = aprobacion.persona.linked_user_id === user.userId;
    const esAdmin = user.role.toLowerCase() === 'admin';
    if (!esDueno && !esLaPersona && !esAdmin) {
      throw new ForbiddenException('No tienes permiso para resolver esta aprobación');
    }

    const actualizada = await this.prisma.aprobacionesPrestamos.update({
      where: { id: aprobacion.id },
      data: { estado: dto.estado, comentarios: dto.comentarios ?? aprobacion.comentarios, fecha_aprobacion: new Date() },
      include: { persona: { select: { nombre: true } } },
    });
    return this.aprobacionJson(actualizada);
  }

  /**
   * `PATCH /prestamos/:id/aprobaciones`: sin `aprobacionId`/`personaId` se usa la persona enlazada al usuario
   * autenticado (`Personas.linked_user_id`), que es quien aprueba o rechaza "su" aprobación.
   */
  async resolverAprobacionPorPersona(prestamoId: number, dto: ResolverAprobacionPorPersonaDto, user: AuthenticatedUser) {
    let aprobacionId = dto.aprobacionId;
    if (aprobacionId === undefined) {
      const personaId =
        dto.personaId !== undefined
          ? BigInt(dto.personaId)
          : (
              await this.prisma.personas.findFirst({
                where: { linked_user_id: user.userId },
                orderBy: { id: 'asc' },
                select: { id: true },
              })
            )?.id;
      if (personaId === undefined) {
        throw datosInvalidos({ personaId: ['No hay una persona enlazada a tu usuario: envía personaId o aprobacionId'] });
      }
      const candidata = await this.prisma.aprobacionesPrestamos.findFirst({
        where: { prestamo_id: BigInt(prestamoId), persona_id: personaId },
        orderBy: [{ estado: 'desc' }, { id: 'asc' }], // "Pendiente" antes que "Aprobado"/"Rechazado"
      });
      if (!candidata) throw new NotFoundException('El préstamo no tiene una aprobación para esa persona');
      aprobacionId = Number(candidata.id);
    }
    return this.resolverAprobacion(prestamoId, aprobacionId, { estado: dto.estado, comentarios: dto.comentarios }, user);
  }

  // ───────────────────────────── cortes ─────────────────────────────

  /** Corte que contiene `fecha`; si no hay, el marcado ACTIVO. */
  async corteParaFecha(tx: Tx, ownerUserId: bigint, fecha: Date): Promise<bigint | null> {
    const porRango = await tx.cortesCobro.findFirst({
      where: { owner_user_id: ownerUserId, fecha_inicio: { lte: fecha }, fecha_final: { gte: fecha } },
      orderBy: { fecha_inicio: 'desc' },
      select: { id: true },
    });
    if (porRango) return porRango.id;
    const activo = await tx.cortesCobro.findFirst({
      where: { owner_user_id: ownerUserId, estado: 'ACTIVO' },
      orderBy: { fecha_inicio: 'desc' },
      select: { id: true },
    });
    return activo?.id ?? null;
  }

  // ───────────────────────────── serialización ─────────────────────────────

  private aprobacionJson(a: {
    id: bigint;
    prestamo_id: bigint;
    persona_id: bigint;
    estado: string;
    comentarios: string | null;
    fecha_aprobacion: Date | null;
    persona?: { nombre: string | null };
  }) {
    return {
      id: idNum(a.id),
      prestamoId: idNum(a.prestamo_id),
      personaId: idNum(a.persona_id),
      persona: a.persona?.nombre ?? null,
      estado: a.estado,
      comentarios: a.comentarios,
      fechaAprobacion: a.fecha_aprobacion ? a.fecha_aprobacion.toISOString() : null,
    };
  }

  private toJson(
    p: Prisma.PrestamosGetPayload<{ include: { aprobaciones: { include: { persona: { select: { nombre: true } } } } } }>,
  ) {
    return {
      // contrato legacy (Json.writes[Prestamo])
      id: idNum(p.id),
      fechaCreacion: timestampToDayMillis(p.created_at),
      valorPrestado: num(p.valor_prestado),
      concepto: p.concepto,
      fechaCobro: dateToMillis(p.fecha_cobro),
      responsable: idNum(p.responsable),
      estado: p.estado,
      comentarios: p.comentarios,
      // esquema Supabase
      direccionPrestamo: p.direccion_prestamo,
      saldoPendiente: numOrNull(p.saldo_pendiente),
      esRecurrenteMensual: p.es_recurrente_mensual,
      cuotaMensualAcordada: numOrNull(p.cuota_mensual_acordada),
      fechaPrestamo: dateToMillis(p.fecha_prestamo),
      metodo: p.metodo,
      corteId: p.corte_id === null ? null : idNum(p.corte_id),
      creadoPorPersonaId: p.creado_por_persona_id === null ? null : idNum(p.creado_por_persona_id),
      origenCruceAporteId: p.origen_cruce_aporte_id === null ? null : idNum(p.origen_cruce_aporte_id),
      aprobaciones: p.aprobaciones.map((a) => this.aprobacionJson(a)),
    };
  }

  private async requireCorte(tx: Tx, corteId: number, ownerUserId: bigint): Promise<bigint> {
    const corte = await tx.cortesCobro.findFirst({
      where: { id: BigInt(corteId), owner_user_id: ownerUserId },
      select: { id: true },
    });
    if (!corte) throw new HttpException({ message: `Corte ${corteId} no encontrado` }, HttpStatus.NOT_FOUND);
    return corte.id;
  }
}
