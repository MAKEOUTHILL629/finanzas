import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { EstadoAprobacion, EstadoPrestamo, EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, toDb, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { dateToMillis, idNum, num, numOrNull, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TransaccionesService } from '../transacciones/transacciones.service';
import {
  CreatePrestamoDto,
  PrestamosFiltroDto,
  ResolverAprobacionDto,
  ResolverAprobacionPorPersonaDto,
  UpdatePrestamoDto,
} from './dto/prestamo.dto';

type Tx = Prisma.TransactionClient;

const INCLUDE_PRESTAMO = {
  aprobaciones: { include: { persona: { select: { nombre: true } } }, orderBy: { id: 'asc' as const } },
  transaccion_desembolso: {
    select: {
      id: true,
      fecha_transaccion: true,
      monto_cop: true,
      concepto: true,
      cuenta_origen_id: true,
      cuenta_origen: { select: { id: true, nombre: true, banco_entidad: true, ultimos_4_digitos: true } },
    },
  },
  cuenta_origen_desembolso: {
    select: { id: true, nombre: true, banco_entidad: true, ultimos_4_digitos: true },
  },
};

/**
 * Préstamos (legacy `PrestamoRepositorio` + extensión ERP v2).
 * El Trigger 4 (`trg_sync_prestamo_subledger`) crea el cargo (+1) al insertar y el abono (-1) al pasar a 'Pagado':
 * este servicio NUNCA inserta en `MovimientosDeudaPersona`.
 */
@Injectable()
export class PrestamosService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly transacciones?: TransaccionesService,
  ) {}

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
      include: INCLUDE_PRESTAMO,
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

    const desembolso = await this.resolverDesembolso(
      tx,
      {
        transaccionDesembolsoId: dto.transaccionDesembolsoId,
        notificacionCorreoId: dto.notificacionCorreoId,
        cuentaOrigenDesembolsoId: dto.cuentaOrigenDesembolsoId,
        crearTransaccionTransferencia: dto.crearTransaccionTransferencia,
        valorPrestado: valor.toString(),
        concepto: dto.concepto,
        fechaPrestamo,
      },
      ownerUserId,
    );

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
        fecha_compromiso_pago: dto.fechaCompromisoPago ? parseIsoDate(dto.fechaCompromisoPago) : null,
        cuenta_destino_tercero: dto.cuentaDestinoTercero?.trim() || null,
        // Token del portal público del acreedor (Fase 6): largo y aleatorio, único.
        token_consulta_publica: (dto.direccionPrestamo ?? 'POR_COBRAR') === 'POR_PAGAR' ? randomBytes(24).toString('hex') : null,
        ...(desembolso.transaccionDesembolsoId !== null ? { transaccion_desembolso_id: desembolso.transaccionDesembolsoId } : {}),
        ...(desembolso.notificacionCorreoId !== null ? { notificacion_correo_id: desembolso.notificacionCorreoId } : {}),
        ...(desembolso.cuentaOrigenDesembolsoId !== null ? { cuenta_origen_desembolso_id: desembolso.cuentaOrigenDesembolsoId } : {}),
      },
    });
    return idNum(creado.id);
  }

  // ───────────────────────────── detalle y edición ─────────────────────────────

  async get(id: number, ownerUserId: bigint) {
    const prestamo = await this.prisma.prestamos.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      include: INCLUDE_PRESTAMO,
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
      if (dto.fechaCompromisoPago !== undefined) {
        const f = parseIsoDate(dto.fechaCompromisoPago);
        if (!f) throw datosInvalidos({ fechaCompromisoPago: ['fechaCompromisoPago debe tener formato yyyy-MM-dd'] });
        data.fecha_compromiso_pago = f;
      }
      if (dto.cuentaDestinoTercero !== undefined) data.cuenta_destino_tercero = dto.cuentaDestinoTercero.trim() || null;

      if (
        dto.transaccionDesembolsoId !== undefined ||
        dto.notificacionCorreoId !== undefined ||
        dto.cuentaOrigenDesembolsoId !== undefined ||
        dto.crearTransaccionTransferencia
      ) {
        if (dto.transaccionDesembolsoId === null) data.transaccion_desembolso_id = null;
        if (dto.notificacionCorreoId === null) data.notificacion_correo_id = null;
        if (dto.cuentaOrigenDesembolsoId === null) data.cuenta_origen_desembolso_id = null;

        if (dto.transaccionDesembolsoId || dto.cuentaOrigenDesembolsoId || dto.notificacionCorreoId) {
          const desembolso = await this.resolverDesembolso(
            tx,
            {
              transaccionDesembolsoId: dto.transaccionDesembolsoId ?? undefined,
              notificacionCorreoId: dto.notificacionCorreoId ?? undefined,
              cuentaOrigenDesembolsoId: dto.cuentaOrigenDesembolsoId ?? undefined,
              crearTransaccionTransferencia: dto.crearTransaccionTransferencia,
              valorPrestado: toDecimal(actual.valor_prestado).toString(),
              concepto: actual.concepto ?? 'Préstamo',
              fechaPrestamo: actual.fecha_prestamo ?? new Date(),
            },
            ownerUserId,
          );
          if (desembolso.transaccionDesembolsoId !== null) data.transaccion_desembolso_id = desembolso.transaccionDesembolsoId;
          if (desembolso.notificacionCorreoId !== null) data.notificacion_correo_id = desembolso.notificacionCorreoId;
          if (desembolso.cuentaOrigenDesembolsoId !== null) data.cuenta_origen_desembolso_id = desembolso.cuentaOrigenDesembolsoId;
        }
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

  /**
   * Iteración 2 — Fase 5:
   * - Si viene `transaccionDesembolsoId`: enlaza la transacción existente al préstamo, asigna la categoría 'Préstamos / Desembolsos'
   *   y enlaza `notificacion_correo_id` si esa transacción fue originada por un correo bancario.
   * - Si viene `cuentaOrigenDesembolsoId` y `crearTransaccionTransferencia = true`: crea automáticamente la transacción de salida
   *   asociada a la cuenta y guarda su ID en `transaccion_desembolso_id`.
   */
  private async resolverDesembolso(
    tx: Tx,
    input: {
      transaccionDesembolsoId?: number;
      notificacionCorreoId?: number;
      cuentaOrigenDesembolsoId?: number;
      crearTransaccionTransferencia?: boolean;
      valorPrestado: string;
      concepto: string;
      fechaPrestamo: Date;
    },
    ownerUserId: bigint,
  ): Promise<{
    transaccionDesembolsoId: bigint | null;
    notificacionCorreoId: bigint | null;
    cuentaOrigenDesembolsoId: bigint | null;
  }> {
    if (!input.transaccionDesembolsoId && !input.cuentaOrigenDesembolsoId && !input.notificacionCorreoId) {
      return { transaccionDesembolsoId: null, notificacionCorreoId: null, cuentaOrigenDesembolsoId: null };
    }

    if (input.transaccionDesembolsoId) {
      const txExistente = await tx.transacciones.findFirst({
        where: { id: BigInt(input.transaccionDesembolsoId), owner_user_id: ownerUserId },
      });
      if (!txExistente) {
        throw new NotFoundException(`Transacción de desembolso ${input.transaccionDesembolsoId} no encontrada`);
      }

      const categoriaPrestamosId = await this.asegurarCategoriaPrestamos(tx, ownerUserId);
      if (categoriaPrestamosId && txExistente.categoria_id !== categoriaPrestamosId) {
        await tx.transacciones.update({
          where: { id: txExistente.id },
          data: { categoria_id: categoriaPrestamosId },
        });
      }

      let notificacionId: bigint | null = input.notificacionCorreoId ? BigInt(input.notificacionCorreoId) : null;
      if (!notificacionId && tx.notificacionesCorreo?.findFirst) {
        const notif = await tx.notificacionesCorreo.findFirst({
          where: { owner_user_id: ownerUserId, transaccion_generada_id: txExistente.id },
          select: { id: true },
        });
        notificacionId = notif?.id ?? null;
      }

      const cuentaId = input.cuentaOrigenDesembolsoId
        ? BigInt(input.cuentaOrigenDesembolsoId)
        : (txExistente.cuenta_origen_id ?? null);

      return {
        transaccionDesembolsoId: txExistente.id,
        notificacionCorreoId: notificacionId,
        cuentaOrigenDesembolsoId: cuentaId,
      };
    }

    if (input.cuentaOrigenDesembolsoId && input.crearTransaccionTransferencia) {
      const cuenta = await tx.cuentasFinancieras.findFirst({
        where: { id: BigInt(input.cuentaOrigenDesembolsoId), owner_user_id: ownerUserId },
        select: { id: true },
      });
      if (!cuenta) {
        throw new NotFoundException(`Cuenta financiera ${input.cuentaOrigenDesembolsoId} no encontrada`);
      }

      const categoriaPrestamosId = await this.asegurarCategoriaPrestamos(tx, ownerUserId);
      const conceptoTx = `Desembolso préstamo: ${input.concepto}`.slice(0, 255);

      let creadaTxId: bigint;
      if (this.transacciones) {
        const creada = await this.transacciones.insertar(
          tx,
          {
            tipoTransaccion: TipoTransaccion.EGRESO,
            cuentaOrigenId: input.cuentaOrigenDesembolsoId,
            cuentaDestinoId: null,
            tarjetaPagadaId: null,
            categoriaId: categoriaPrestamosId ? Number(categoriaPrestamosId) : null,
            fechaTransaccion: input.fechaPrestamo,
            concepto: conceptoTx,
            monedaOriginal: 'COP',
            montoOriginal: input.valorPrestado,
            origenRegistro: OrigenRegistro.MANUAL,
            estado: EstadoTransaccion.CONFIRMADO,
            notas: 'Generada automáticamente al registrar el préstamo con desembolso desde cuenta',
          },
          ownerUserId,
        );
        creadaTxId = creada.id;
      } else {
        const montoDec = money(toDecimal(input.valorPrestado));
        const creada = await tx.transacciones.create({
          data: {
            owner_user_id: ownerUserId,
            tipo_transaccion: TipoTransaccion.EGRESO,
            cuenta_origen_id: cuenta.id,
            cuenta_destino_id: null,
            tarjeta_pagada_id: null,
            categoria_id: categoriaPrestamosId,
            fecha_transaccion: input.fechaPrestamo,
            concepto: conceptoTx,
            moneda_original: 'COP',
            monto_original: toDbMoney(montoDec),
            tasa_cambio: toDb(toDecimal(1)),
            monto_cop: toDbMoney(montoDec),
            origen_registro: OrigenRegistro.MANUAL,
            estado: EstadoTransaccion.CONFIRMADO,
            notas: 'Generada automáticamente al registrar el préstamo con desembolso desde cuenta',
          },
        });
        creadaTxId = creada.id;
      }

      return {
        transaccionDesembolsoId: creadaTxId,
        notificacionCorreoId: input.notificacionCorreoId ? BigInt(input.notificacionCorreoId) : null,
        cuentaOrigenDesembolsoId: cuenta.id,
      };
    }

    return {
      transaccionDesembolsoId: null,
      notificacionCorreoId: input.notificacionCorreoId ? BigInt(input.notificacionCorreoId) : null,
      cuentaOrigenDesembolsoId: input.cuentaOrigenDesembolsoId ? BigInt(input.cuentaOrigenDesembolsoId) : null,
    };
  }

  private async asegurarCategoriaPrestamos(tx: Tx, ownerUserId: bigint): Promise<bigint | null> {
    if (!tx.categorias?.findFirst) return null;
    const existente = await tx.categorias.findFirst({
      where: {
        owner_user_id: ownerUserId,
        nombre: { equals: 'Préstamos / Desembolsos', mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existente) return existente.id;
    if (!tx.categorias.create) return null;
    const creada = await tx.categorias.create({
      data: {
        owner_user_id: ownerUserId,
        nombre: 'Préstamos / Desembolsos',
        tipo: 'AMBOS',
        icono: 'handshake',
        color: '#6366F1',
      },
      select: { id: true },
    });
    return creada?.id ?? null;
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
    p: Prisma.PrestamosGetPayload<{ include: typeof INCLUDE_PRESTAMO }>,
  ) {
    const txDesembolso = (p as { transaccion_desembolso?: typeof INCLUDE_PRESTAMO.transaccion_desembolso extends { select: infer S } ? Record<keyof S, any> : never }).transaccion_desembolso ?? null;
    const cuentaDesembolso = (p as { cuenta_origen_desembolso?: { id: bigint; nombre: string; banco_entidad: string | null; ultimos_4_digitos: string | null } }).cuenta_origen_desembolso ?? null;

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
      // Fase 6: solo viaja al dueño (el portal público arma su propia vista sin este token suelto en listados ajenos).
      fechaCompromisoPago: dateToMillis(p.fecha_compromiso_pago),
      cuentaDestinoTercero: p.cuenta_destino_tercero,
      tokenConsultaPublica: p.token_consulta_publica,
      // Iteración 2 — Fase 5: trazabilidad de desembolso / transferencia / correo
      transaccionDesembolsoId: p.transaccion_desembolso_id === null || p.transaccion_desembolso_id === undefined ? null : idNum(p.transaccion_desembolso_id),
      notificacionCorreoId: p.notificacion_correo_id === null || p.notificacion_correo_id === undefined ? null : idNum(p.notificacion_correo_id),
      cuentaOrigenDesembolsoId: p.cuenta_origen_desembolso_id === null || p.cuenta_origen_desembolso_id === undefined ? null : idNum(p.cuenta_origen_desembolso_id),
      trazabilidadDesembolso: txDesembolso
        ? {
            transaccionId: idNum(txDesembolso.id),
            fechaHora: txDesembolso.fecha_transaccion instanceof Date ? txDesembolso.fecha_transaccion.toISOString() : null,
            montoCop: num(txDesembolso.monto_cop),
            concepto: txDesembolso.concepto,
            cuentaOrigenId: txDesembolso.cuenta_origen_id ? idNum(txDesembolso.cuenta_origen_id) : (p.cuenta_origen_desembolso_id ? idNum(p.cuenta_origen_desembolso_id) : null),
            cuentaOrigenNombre: txDesembolso.cuenta_origen?.nombre ?? cuentaDesembolso?.nombre ?? null,
            cuentaOrigenBanco: txDesembolso.cuenta_origen?.banco_entidad ?? cuentaDesembolso?.banco_entidad ?? null,
            cuentaOrigenUltimos4: txDesembolso.cuenta_origen?.ultimos_4_digitos ?? cuentaDesembolso?.ultimos_4_digitos ?? null,
            notificacionCorreoId: p.notificacion_correo_id ? idNum(p.notificacion_correo_id) : null,
          }
        : cuentaDesembolso
          ? {
              transaccionId: null,
              fechaHora: null,
              montoCop: num(p.valor_prestado),
              concepto: p.concepto,
              cuentaOrigenId: idNum(cuentaDesembolso.id),
              cuentaOrigenNombre: cuentaDesembolso.nombre,
              cuentaOrigenBanco: cuentaDesembolso.banco_entidad,
              cuentaOrigenUltimos4: cuentaDesembolso.ultimos_4_digitos,
              notificacionCorreoId: p.notificacion_correo_id ? idNum(p.notificacion_correo_id) : null,
            }
          : null,
      aprobaciones: (p.aprobaciones ?? []).map((a) => this.aprobacionJson(a)),
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
