import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Transacciones } from '@prisma/client';
import { EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { money, rate, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCategoria, assertCuenta, assertTarjeta } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTransaccionDto, TransaccionesFiltroDto, UpdateTransaccionDto } from './dto/transaccion.dto';
import { validarReglasTransaccion } from './transaccion.rules';

type Tx = Prisma.TransactionClient;

interface DatosTransaccion {
  tipoTransaccion: TipoTransaccion;
  cuentaOrigenId: number | null;
  cuentaDestinoId: number | null;
  tarjetaPagadaId: number | null;
  categoriaId: number | null;
  fechaTransaccion: Date;
  concepto: string;
  monedaOriginal: string;
  montoOriginal: number | string;
  tasaCambio?: number | string | null;
  montoCop?: number | string | null;
  origenRegistro: OrigenRegistro;
  estado: EstadoTransaccion;
  notas: string | null;
}

/**
 * Libro diario. NUNCA se escribe `CuentasFinancieras.saldo_actual` desde aquí: el Trigger 2
 * (`trg_actualizar_saldo_cuenta`) lo ajusta al insertar/actualizar/eliminar una transacción CONFIRMADA.
 */
@Injectable()
export class TransaccionesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerUserId: bigint, filtro: TransaccionesFiltroDto) {
    const tipo = filtro.tipo ?? filtro.tipo_transaccion;
    const cuentaId = filtro.cuentaId ?? filtro.cuenta_id;
    const categoriaId = filtro.categoriaId ?? filtro.categoria_id;
    const rango = filtro.periodo ? this.rangoDelPeriodo(filtro.periodo) : { desde: filtro.desde, hasta: filtro.hasta };
    const where: Prisma.TransaccionesWhereInput = {
      owner_user_id: ownerUserId,
      ...(tipo ? { tipo_transaccion: tipo } : {}),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.origen_registro ? { origen_registro: filtro.origen_registro } : {}),
      ...(categoriaId ? { categoria_id: BigInt(categoriaId) } : {}),
      ...(cuentaId ? { OR: [{ cuenta_origen_id: BigInt(cuentaId) }, { cuenta_destino_id: BigInt(cuentaId) }] } : {}),
      ...(rango.desde || rango.hasta
        ? {
            fecha_transaccion: {
              ...(rango.desde ? { gte: new Date(rango.desde) } : {}),
              ...(rango.hasta ? { lte: this.finDeDia(rango.hasta) } : {}),
            },
          }
        : {}),
    };
    const limit = filtro.limit ?? 100;
    const offset = filtro.offset ?? 0;
    const [total, items] = await Promise.all([
      this.prisma.transacciones.count({ where }),
      this.prisma.transacciones.findMany({
        where,
        orderBy: [{ fecha_transaccion: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
    ]);
    return { total, limit, offset, items };
  }

  async get(id: number, ownerUserId: bigint): Promise<Transacciones> {
    const tx = await this.prisma.transacciones.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!tx) throw new NotFoundException(`Transacción ${id} no encontrada`);
    return tx;
  }

  async create(dto: CreateTransaccionDto, ownerUserId: bigint): Promise<Transacciones> {
    const origenRegistro = dto.origenRegistro ?? OrigenRegistro.MANUAL;
    const datos: DatosTransaccion = {
      tipoTransaccion: dto.tipoTransaccion,
      cuentaOrigenId: dto.cuentaOrigenId ?? null,
      cuentaDestinoId: dto.cuentaDestinoId ?? null,
      tarjetaPagadaId: dto.tarjetaPagadaId ?? null,
      categoriaId: dto.categoriaId ?? null,
      fechaTransaccion: dto.fechaTransaccion ? new Date(dto.fechaTransaccion) : new Date(),
      concepto: dto.concepto,
      monedaOriginal: (dto.monedaOriginal ?? 'COP').toUpperCase(),
      montoOriginal: dto.montoOriginal,
      tasaCambio: dto.tasaCambio,
      montoCop: dto.montoCop,
      origenRegistro,
      estado:
        dto.estado ??
        (origenRegistro === OrigenRegistro.EMAIL_AUTO ? EstadoTransaccion.PENDIENTE_REVISION : EstadoTransaccion.CONFIRMADO),
      notas: dto.notas ?? null,
    };
    return this.prisma.$transaction((tx) => this.insertar(tx, datos, ownerUserId));
  }

  /** Inserción reutilizable (ingesta de correos, pagos recurrentes) dentro de una transacción existente. */
  async insertar(
    tx: Tx,
    datos: DatosTransaccion,
    ownerUserId: bigint,
    opciones: OpcionesInsercion = {},
  ): Promise<Transacciones> {
    await this.validarYResolverReferencias(tx, datos, ownerUserId, opciones);
    const { montoOriginal, tasa, montoCop } = this.resolverMontos(datos);
    return tx.transacciones.create({
      data: {
        owner_user_id: ownerUserId,
        tipo_transaccion: datos.tipoTransaccion,
        cuenta_origen_id: datos.cuentaOrigenId === null ? null : BigInt(datos.cuentaOrigenId),
        cuenta_destino_id: datos.cuentaDestinoId === null ? null : BigInt(datos.cuentaDestinoId),
        tarjeta_pagada_id: datos.tarjetaPagadaId === null ? null : BigInt(datos.tarjetaPagadaId),
        categoria_id: datos.categoriaId === null ? null : BigInt(datos.categoriaId),
        fecha_transaccion: datos.fechaTransaccion,
        concepto: datos.concepto,
        moneda_original: datos.monedaOriginal,
        monto_original: toDbMoney(montoOriginal),
        tasa_cambio: toDbRate(tasa),
        monto_cop: toDbMoney(montoCop),
        origen_registro: datos.origenRegistro,
        estado: datos.estado,
        notas: datos.notas,
      },
    });
  }

  async update(id: number, dto: UpdateTransaccionDto, ownerUserId: bigint): Promise<Transacciones> {
    return this.prisma.$transaction(async (tx) => {
      const actual = await tx.transacciones.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Transacción ${id} no encontrada`);

      const fusion: DatosTransaccion = {
        tipoTransaccion: dto.tipoTransaccion ?? (actual.tipo_transaccion as TipoTransaccion),
        cuentaOrigenId: dto.cuentaOrigenId !== undefined ? dto.cuentaOrigenId : this.num(actual.cuenta_origen_id),
        cuentaDestinoId: dto.cuentaDestinoId !== undefined ? dto.cuentaDestinoId : this.num(actual.cuenta_destino_id),
        tarjetaPagadaId: dto.tarjetaPagadaId !== undefined ? dto.tarjetaPagadaId : this.num(actual.tarjeta_pagada_id),
        categoriaId: dto.categoriaId !== undefined ? dto.categoriaId : this.num(actual.categoria_id),
        fechaTransaccion: dto.fechaTransaccion ? new Date(dto.fechaTransaccion) : actual.fecha_transaccion,
        concepto: dto.concepto ?? actual.concepto,
        monedaOriginal: actual.moneda_original,
        montoOriginal: dto.montoOriginal ?? actual.monto_original.toString(),
        tasaCambio: dto.tasaCambio ?? actual.tasa_cambio.toString(),
        // Si cambió el monto o la tasa y no se envió monto COP, se recalcula; si no, se conserva.
        montoCop:
          dto.montoCop ??
          (dto.montoOriginal !== undefined || dto.tasaCambio !== undefined ? undefined : actual.monto_cop.toString()),
        origenRegistro: (actual.origen_registro as OrigenRegistro | null) ?? OrigenRegistro.MANUAL,
        estado: dto.estado ?? (actual.estado as EstadoTransaccion | null) ?? EstadoTransaccion.CONFIRMADO,
        notas: dto.notas ?? actual.notas,
      };

      await this.validarYResolverReferencias(tx, fusion, ownerUserId);
      const { montoOriginal, tasa, montoCop } = this.resolverMontos(fusion);

      return tx.transacciones.update({
        where: { id: actual.id },
        data: {
          tipo_transaccion: fusion.tipoTransaccion,
          cuenta_origen_id: fusion.cuentaOrigenId === null ? null : BigInt(fusion.cuentaOrigenId),
          cuenta_destino_id: fusion.cuentaDestinoId === null ? null : BigInt(fusion.cuentaDestinoId),
          tarjeta_pagada_id: fusion.tarjetaPagadaId === null ? null : BigInt(fusion.tarjetaPagadaId),
          categoria_id: fusion.categoriaId === null ? null : BigInt(fusion.categoriaId),
          fecha_transaccion: fusion.fechaTransaccion,
          concepto: fusion.concepto,
          monto_original: toDbMoney(montoOriginal),
          tasa_cambio: toDbRate(tasa),
          monto_cop: toDbMoney(montoCop),
          estado: fusion.estado,
          notas: fusion.notas,
        },
      });
    });
  }

  /** "Eliminar" = anular: el Trigger 2 revierte el saldo y se conserva la auditoría (FKs desde el sub-ledger). */
  async anular(id: number, ownerUserId: bigint): Promise<Transacciones> {
    const actual = await this.get(id, ownerUserId);
    return this.prisma.transacciones.update({ where: { id: actual.id }, data: { estado: EstadoTransaccion.ANULADO } });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async validarYResolverReferencias(
    tx: Tx,
    datos: DatosTransaccion,
    ownerUserId: bigint,
    opciones: OpcionesInsercion = {},
  ): Promise<void> {
    // Un correo de "pago de tarjeta" a veces solo identifica la cuenta de origen: se admite sin tarjeta_pagada_id.
    const errores = validarReglasTransaccion(datos).filter(
      (e) => !(opciones.permitirPagoTarjetaSinTarjeta && e.startsWith('tarjetaPagadaId es obligatoria')),
    );
    if (errores.length > 0) throw datosInvalidos({ transaccion: errores });

    if (datos.cuentaOrigenId !== null) await assertCuenta(tx, datos.cuentaOrigenId, ownerUserId);
    if (datos.cuentaDestinoId !== null) await assertCuenta(tx, datos.cuentaDestinoId, ownerUserId);
    if (datos.tarjetaPagadaId !== null) await assertTarjeta(tx, datos.tarjetaPagadaId, ownerUserId);
    if (datos.categoriaId !== null) await assertCategoria(tx, datos.categoriaId, ownerUserId);
  }

  /** Monto original, tasa y monto COP con Decimal. COP → tasa 1; otra divisa exige tasa. */
  private resolverMontos(datos: DatosTransaccion) {
    const montoOriginal = money(toDecimal(datos.montoOriginal));
    if (!montoOriginal.greaterThan(0)) throw datosInvalidos({ montoOriginal: ['montoOriginal debe ser mayor a 0'] });

    const esCop = datos.monedaOriginal === 'COP';
    const tasaDada = datos.tasaCambio === undefined || datos.tasaCambio === null ? null : rate(toDecimal(datos.tasaCambio));
    if (!esCop && (!tasaDada || !tasaDada.greaterThan(0))) {
      throw datosInvalidos({ tasaCambio: [`tasaCambio es obligatoria para ${datos.monedaOriginal}`] });
    }
    const tasa = esCop ? toDecimal(1) : (tasaDada as ReturnType<typeof toDecimal>);
    const montoCop =
      datos.montoCop === undefined || datos.montoCop === null ? money(montoOriginal.mul(tasa)) : money(toDecimal(datos.montoCop));
    if (!montoCop.greaterThan(0)) throw datosInvalidos({ montoCop: ['montoCop debe ser mayor a 0'] });
    return { montoOriginal, tasa, montoCop };
  }

  private num(value: bigint | null): number | null {
    return value === null ? null : Number(value);
  }

  /** Mes completo en hora local de Bogotá (UTC-5), como se registran los movimientos. */
  private rangoDelPeriodo(periodo: string): { desde: string; hasta: string } {
    const [y, m] = periodo.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { desde: `${periodo}-01T00:00:00-05:00`, hasta: `${periodo}-${String(ultimo).padStart(2, '0')}T23:59:59.999-05:00` };
  }

  private finDeDia(valor: string): Date {
    return valor.length === 10 ? new Date(`${valor}T23:59:59.999Z`) : new Date(valor);
  }
}

export interface OpcionesInsercion {
  /** Solo para la ingesta automática de correos: permite PAGO_TARJETA sin `tarjeta_pagada_id`. */
  permitirPagoTarjetaSinTarjeta?: boolean;
}

export type { DatosTransaccion };
