import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Tarjetas } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import {
  EstadoNotificacionCorreo,
  EstadoTransaccion,
  OrigenRegistro,
  TipoTransaccion,
} from '../../common/enums/finance.enums';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, rate, toDb, toDecimal } from '../../common/utils/decimal.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService, TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { DatosTransaccion, TransaccionesService } from '../transacciones/transacciones.service';
import {
  construirFechaHora,
  CuentaCandidata,
  decidirRuta,
  detectarInstrumento,
  extraerUltimos4,
  Instrumento,
  parseMontoBancolombia,
  prioridadRuta,
  resolverCuenta,
  resolverTarjeta,
  RutaSync,
} from './bancolombia-normalizer.util';
import { NotificacionItemDto } from './dto/sync-batch.dto';
import { insertarNotificacionIdempotente, resolverTrmUsd } from './notificaciones.repository';

export type ResultadoItem = 'INSERTADO' | 'EXISTENTE' | 'ERROR';

export interface DetalleItemSync {
  externalMessageId: string;
  resultado: ResultadoItem;
  ruta?: RutaSync;
  estadoProcesamiento?: string;
  transaccionId?: number | null;
  compraCreditoId?: number | null;
  motivo?: string | null;
  error?: string;
}

export interface SyncBatchResult {
  totalRecibidos: number;
  nuevosInsertados: number;
  yaExistentesIdempotentes: number;
  /** IDs ya persistidos (nuevos + idempotentes): el script puede marcarlos como sincronizados. */
  syncedExternalIds: string[];
  /** Ítems que fallaron por un error transitorio (se revirtieron): NO están en `syncedExternalIds`. */
  errores: Array<{ externalMessageId: string; error: string }>;
  detalle: DetalleItemSync[];
}

interface ContextoSync {
  ownerUserId: bigint;
  cuentas: Array<CuentaCandidata & { moneda: string }>;
  tarjetas: Tarjetas[];
  offset: string;
  trmRespaldo: Decimal | null;
}

interface Resolucion {
  estado: EstadoNotificacionCorreo;
  motivo: string | null;
  transaccionId: bigint | null;
  compraId: bigint | null;
}

const REMITENTE = 'Bancolombia (Gmail)';
const VENTANA_DUPLICADO_MS = 5 * 60 * 1000;

/**
 * Sincronización por lotes de las notificaciones de Bancolombia (webhook del Google Apps Script).
 *
 * Idempotente por `external_message_id`. Cada ítem se procesa en su PROPIA transacción: si uno falla se revierte
 * solo ese ítem y se reporta en `errores` (no entra a `syncedExternalIds`, así el script lo reintenta).
 * NO se duplica lógica de la BD: el saldo lo mueve el Trigger 2 (transacciones CONFIRMADO) y el sub-ledger los
 * triggers 1/6/8 al crear compras y cuotas.
 */
@Injectable()
export class SyncBatchService {
  private readonly logger = new Logger(SyncBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly compras: ComprasCreditoService,
    private readonly transacciones: TransaccionesService,
    private readonly config: ConfigService,
  ) {}

  async syncBatch(items: NotificacionItemDto[], ownerUserId: bigint): Promise<SyncBatchResult> {
    const resultado: SyncBatchResult = {
      totalRecibidos: items.length,
      nuevosInsertados: 0,
      yaExistentesIdempotentes: 0,
      syncedExternalIds: [],
      errores: [],
      detalle: [],
    };
    const existente = (id: string) => {
      resultado.yaExistentesIdempotentes += 1;
      resultado.syncedExternalIds.push(id);
      resultado.detalle.push({ externalMessageId: id, resultado: 'EXISTENTE' });
    };

    // 1. Duplicados dentro del propio lote
    const vistos = new Set<string>();
    const unicos: NotificacionItemDto[] = [];
    for (const item of items) {
      if (vistos.has(item.externalMessageId)) existente(item.externalMessageId);
      else {
        vistos.add(item.externalMessageId);
        unicos.push(item);
      }
    }

    // 2. Ya existentes en BD (idempotencia estricta)
    const enBd = new Set(
      (
        await this.prisma.notificacionesCorreo.findMany({
          where: { external_message_id: { in: unicos.map((i) => i.externalMessageId) } },
          select: { external_message_id: true },
        })
      ).map((n) => n.external_message_id),
    );
    const nuevos = unicos.filter((i) => {
      if (enBd.has(i.externalMessageId)) {
        existente(i.externalMessageId);
        return false;
      }
      return true;
    });
    if (nuevos.length === 0) return resultado;

    // 3. Precarga de cuentas y tarjetas del propietario
    const contexto = await this.cargarContexto(ownerUserId);

    // 4. Orden cronológico (débito antes que abono del mismo pago) y 5. proceso aislado por ítem
    const offset = contexto.offset;
    const ordenados = [...nuevos].sort((a, b) => {
      const ta = construirFechaHora(a.fecha, a.hora, offset)?.getTime() ?? 0;
      const tb = construirFechaHora(b.fecha, b.hora, offset)?.getTime() ?? 0;
      return ta - tb || prioridadRuta(a) - prioridadRuta(b);
    });

    for (const item of ordenados) {
      try {
        const detalle = await this.prisma.$transaction((tx) => this.procesarItem(tx, item, contexto), TX_OPTIONS);
        if (detalle.resultado === 'EXISTENTE') {
          existente(item.externalMessageId);
        } else {
          resultado.nuevosInsertados += 1;
          resultado.syncedExternalIds.push(item.externalMessageId);
          resultado.detalle.push(detalle);
        }
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : String(error);
        this.logger.error(`No se pudo sincronizar ${item.externalMessageId}: ${mensaje}`);
        resultado.errores.push({ externalMessageId: item.externalMessageId, error: mensaje });
        resultado.detalle.push({ externalMessageId: item.externalMessageId, resultado: 'ERROR', error: mensaje });
      }
    }
    return resultado;
  }

  // ───────────────────────────── ítem ─────────────────────────────

  private async procesarItem(tx: Prisma.TransactionClient, item: NotificacionItemDto, ctx: ContextoSync): Promise<DetalleItemSync> {
    const moneda = item.moneda ?? 'COP';
    const ultimos4 = extraerUltimos4(item.origenRaw);
    const instrumento = detectarInstrumento(item.origenRaw, item.metodo);
    const ruta = decidirRuta(item);
    const fechaValida = construirFechaHora(item.fecha, item.hora, ctx.offset);
    const monto = parseMontoBancolombia(item.valor, moneda);

    const datosBase: Record<string, unknown> = {
      tipo: item.tipo,
      metodo: item.metodo,
      comercio: item.comercio ?? null,
      origenRaw: item.origenRaw ?? null,
      valor: item.valor ?? null,
      moneda,
      linkCorreo: item.linkCorreo ?? null,
      ultimos_4: ultimos4,
      instrumento,
      ruta,
      monto: monto?.toString() ?? null,
      fecha: item.fecha,
      hora: item.hora,
    };

    const notificacionId = await insertarNotificacionIdempotente(tx, {
      ownerUserId: ctx.ownerUserId,
      externalMessageId: item.externalMessageId,
      remitente: REMITENTE,
      asunto: item.asunto ?? `${item.tipo} · ${item.metodo}`,
      fechaCorreo: fechaValida ?? new Date(),
      cuerpoExtraido: item.cuerpoExtraido ?? null,
      datosParseados: datosBase,
    });
    if (notificacionId === null) return { externalMessageId: item.externalMessageId, resultado: 'EXISTENTE' };

    const resolucion = await this.resolver(tx, item, ctx, { ruta, monto, moneda, ultimos4, instrumento, fecha: fechaValida });

    await tx.notificacionesCorreo.update({
      where: { id: notificacionId },
      data: {
        estado_procesamiento: resolucion.estado,
        transaccion_generada_id: resolucion.transaccionId,
        compra_credito_generada_id: resolucion.compraId,
        datos_parseados: { ...datosBase, motivo: resolucion.motivo } as Prisma.InputJsonObject,
      },
    });

    return {
      externalMessageId: item.externalMessageId,
      resultado: 'INSERTADO',
      ruta,
      estadoProcesamiento: resolucion.estado,
      transaccionId: resolucion.transaccionId === null ? null : Number(resolucion.transaccionId),
      compraCreditoId: resolucion.compraId === null ? null : Number(resolucion.compraId),
      motivo: resolucion.motivo,
    };
  }

  private async resolver(
    tx: Prisma.TransactionClient,
    item: NotificacionItemDto,
    ctx: ContextoSync,
    p: { ruta: RutaSync; monto: Decimal | null; moneda: 'COP' | 'USD'; ultimos4: string | null; instrumento: Instrumento; fecha: Date | null },
  ): Promise<Resolucion> {
    const pendiente = (motivo: string): Resolucion => ({ estado: EstadoNotificacionCorreo.PENDIENTE, motivo, transaccionId: null, compraId: null });

    if (p.ruta === 'IGNORAR') {
      return { estado: EstadoNotificacionCorreo.IGNORADO, motivo: 'aviso_informativo_o_error_de_parseo', transaccionId: null, compraId: null };
    }
    if (p.ruta === 'SIN_RUTA') return pendiente('tipo_o_metodo_no_reconocido');
    if (!p.fecha) return { estado: EstadoNotificacionCorreo.ERROR, motivo: 'fecha_u_hora_invalida', transaccionId: null, compraId: null };
    if (!p.monto || !p.monto.greaterThan(0)) {
      return { estado: EstadoNotificacionCorreo.ERROR, motivo: 'monto_invalido', transaccionId: null, compraId: null };
    }
    const monto = p.monto;

    // TRM para divisas: la del último movimiento USD del usuario, o la de respaldo configurada
    let tasa: Decimal | null = null;
    if (p.moneda === 'USD') {
      tasa = await resolverTrmUsd(tx, ctx.ownerUserId, ctx.trmRespaldo);
      if (!tasa) return pendiente('trm_no_disponible');
    }

    switch (p.ruta) {
      case 'COMPRA_TC': {
        const tarjeta = resolverTarjeta(ctx.tarjetas, p.ultimos4);
        if (!tarjeta) return pendiente('tarjeta_no_identificada');
        const esAvance = item.tipo.trim().toLowerCase() === 'avance';
        const interes = (esAvance ? tarjeta.tasa_interes_avance : tarjeta.tasa_interes_compra)?.toString() ?? '0';
        const fechaCompra = parseIsoDate(item.fecha);
        if (!fechaCompra) return { estado: EstadoNotificacionCorreo.ERROR, motivo: 'fecha_invalida', transaccionId: null, compraId: null };

        const compraId = await this.compras.saveTx(
          tx,
          {
            concepto: `${esAvance ? 'Avance - ' : ''}${item.comercio ?? item.asunto ?? 'Compra Bancolombia'}`.slice(0, 255),
            valorCompra: p.moneda === 'COP' ? monto.toString() : undefined,
            fechaCompra,
            numeroCuotas: 1, // por defecto; el usuario ajusta cuotas/responsables al conciliar
            interes,
            descripcion: `Importada del correo ${item.linkCorreo ?? item.externalMessageId}`,
            estado: 'Pendiente',
            tarjeta: tarjeta.id,
            ...(p.moneda === 'USD' && tasa
              ? { monedaOriginal: 'USD', valorMonedaOriginal: monto.toString(), tasaCambioAplicada: tasa.toString(), trmConfirmada: false }
              : {}),
          },
          ctx.ownerUserId,
        );
        // El usuario debe confirmar cuotas y responsables en Angular → la notificación queda PENDIENTE
        return { estado: EstadoNotificacionCorreo.PENDIENTE, motivo: 'compra_tc_creada_a_1_cuota', transaccionId: null, compraId: BigInt(compraId) };
      }

      case 'PAGO_TARJETA':
        return this.resolverPagoTarjeta(tx, item, ctx, { ...p, monto, tasa });

      case 'INGRESO':
      case 'EGRESO': {
        const cuenta = resolverCuenta(ctx.cuentas, p.ultimos4);
        if (!cuenta) return pendiente('cuenta_no_identificada');
        const esIngreso = p.ruta === 'INGRESO';
        const tx1 = await this.transacciones.insertar(
          tx,
          this.datosTransaccion({
            tipo: esIngreso ? TipoTransaccion.INGRESO : TipoTransaccion.EGRESO,
            cuentaId: Number(cuenta.id),
            esOrigen: !esIngreso,
            item,
            fecha: p.fecha,
            monto,
            moneda: p.moneda,
            tasa,
            tarjetaPagadaId: null,
          }),
          ctx.ownerUserId,
        );
        return { estado: EstadoNotificacionCorreo.CONCILIADO, motivo: 'transaccion_confirmada_automaticamente', transaccionId: tx1.id, compraId: null };
      }

      default:
        return pendiente('ruta_no_soportada');
    }
  }

  /**
   * Pago de tarjeta: el banco envía dos correos (débito en cuenta y abono en la tarjeta). Si ya existe un
   * PAGO_TARJETA por el mismo monto en una ventana de ±5 min, se enlaza en lugar de duplicar.
   */
  private async resolverPagoTarjeta(
    tx: Prisma.TransactionClient,
    item: NotificacionItemDto,
    ctx: ContextoSync,
    p: { monto: Decimal; moneda: 'COP' | 'USD'; tasa: Decimal | null; ultimos4: string | null; instrumento: Instrumento; fecha: Date | null },
  ): Promise<Resolucion> {
    const fecha = p.fecha as Date;
    const montoCop = p.moneda === 'USD' && p.tasa ? money(p.monto.mul(rate(p.tasa))) : money(p.monto);

    const cuentaOrigen = p.instrumento === 'CUENTA' ? resolverCuenta(ctx.cuentas, p.ultimos4) : null;
    const tarjeta =
      p.instrumento === 'TC'
        ? resolverTarjeta(ctx.tarjetas, p.ultimos4)
        : resolverTarjeta(ctx.tarjetas, extraerUltimos4(item.comercio) ?? this.tarjetaEnTexto(item.cuerpoExtraido));

    const duplicada = await tx.transacciones.findFirst({
      where: {
        owner_user_id: ctx.ownerUserId,
        tipo_transaccion: TipoTransaccion.PAGO_TARJETA,
        estado: { not: EstadoTransaccion.ANULADO },
        monto_cop: toDb(montoCop),
        fecha_transaccion: { gte: new Date(fecha.getTime() - VENTANA_DUPLICADO_MS), lte: new Date(fecha.getTime() + VENTANA_DUPLICADO_MS) },
      },
      orderBy: { id: 'asc' },
    });
    if (duplicada) {
      if (tarjeta && duplicada.tarjeta_pagada_id === null) {
        await tx.transacciones.update({ where: { id: duplicada.id }, data: { tarjeta_pagada_id: tarjeta.id } });
      }
      return { estado: EstadoNotificacionCorreo.CONCILIADO, motivo: 'duplicado_de_pago_tarjeta_existente', transaccionId: duplicada.id, compraId: null };
    }

    if (!cuentaOrigen) {
      return { estado: EstadoNotificacionCorreo.PENDIENTE, motivo: 'cuenta_origen_no_identificada', transaccionId: null, compraId: null };
    }
    const creada = await this.transacciones.insertar(
      tx,
      this.datosTransaccion({
        tipo: TipoTransaccion.PAGO_TARJETA,
        cuentaId: Number(cuentaOrigen.id),
        esOrigen: true,
        item,
        fecha,
        monto: p.monto,
        moneda: p.moneda,
        tasa: p.tasa,
        tarjetaPagadaId: tarjeta ? Number(tarjeta.id) : null,
      }),
      ctx.ownerUserId,
      { permitirPagoTarjetaSinTarjeta: true },
    );
    return { estado: EstadoNotificacionCorreo.CONCILIADO, motivo: tarjeta ? 'pago_tarjeta_registrado' : 'pago_tarjeta_sin_tarjeta_identificada', transaccionId: creada.id, compraId: null };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private datosTransaccion(p: {
    tipo: TipoTransaccion;
    cuentaId: number;
    esOrigen: boolean;
    item: NotificacionItemDto;
    fecha: Date;
    monto: Decimal;
    moneda: 'COP' | 'USD';
    tasa: Decimal | null;
    tarjetaPagadaId: number | null;
  }): DatosTransaccion {
    return {
      tipoTransaccion: p.tipo,
      cuentaOrigenId: p.esOrigen ? p.cuentaId : null,
      cuentaDestinoId: p.esOrigen ? null : p.cuentaId,
      tarjetaPagadaId: p.tarjetaPagadaId,
      categoriaId: null,
      fechaTransaccion: p.fecha,
      concepto: (p.item.comercio ?? p.item.asunto ?? `${p.item.tipo} ${p.item.metodo}`).slice(0, 255),
      monedaOriginal: p.moneda,
      montoOriginal: p.monto.toString(),
      tasaCambio: p.moneda === 'USD' ? p.tasa?.toString() : undefined,
      origenRegistro: OrigenRegistro.EMAIL_AUTO,
      estado: EstadoTransaccion.CONFIRMADO,
      notas: `Sincronizado desde Bancolombia (${p.item.externalMessageId})`,
    };
  }

  /** "pago tarjeta *1927" / "T.Cred *1927" dentro del cuerpo del correo. */
  private tarjetaEnTexto(texto: string | null | undefined): string | null {
    if (!texto) return null;
    const m = /(?:t\.?\s*cred|tarjeta(?:\s+de)?\s+cr[eé]dito|tarjeta)[^\d*]{0,20}\*?\s*(?<!\d)(\d{4})(?!\d)/i.exec(texto);
    return m ? m[1] : null;
  }

  private async cargarContexto(ownerUserId: bigint): Promise<ContextoSync> {
    const [cuentas, tarjetas] = await Promise.all([
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId, is_active: { not: false } },
        select: { id: true, ultimos_4_digitos: true, moneda: true },
      }),
      this.prisma.tarjetas.findMany({ where: { owner_user_id: ownerUserId } }),
    ]);
    const trm = this.config.get<string | number>('DEFAULT_TRM_USD');
    return {
      ownerUserId,
      cuentas,
      tarjetas,
      offset: this.config.get<string>('SYNC_TZ_OFFSET') ?? '-05:00',
      trmRespaldo: trm === undefined || trm === null || trm === '' ? null : rate(toDecimal(trm)),
    };
  }
}
