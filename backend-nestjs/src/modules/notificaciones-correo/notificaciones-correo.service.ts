import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComprasCredito, NotificacionesCorreo, Prisma, Transacciones } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import {
  EstadoNotificacionCorreo,
  EstadoTransaccion,
  OrigenRegistro,
  TipoTransaccion,
} from '../../common/enums/finance.enums';
import { formatIsoDate, parseIsoDate, truncateToDay } from '../../common/utils/date.util';
import { money, rate, sumDecimals, tryToDecimal, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCategoria, assertCuenta } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService, TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { ResponsablesService } from '../compras-credito/responsables.service';
import { PrestamosService } from '../prestamos/prestamos.service';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { ConciliarCorreoDto, IngestaCorreoDto, NotificacionesFiltroDto } from './dto/notificacion.dto';
import { insertarNotificacionIdempotente, resolverTrmUsd } from './notificaciones.repository';

type Tx = Prisma.TransactionClient;

export interface DatosInterpretados {
  monto: Decimal | null;
  moneda: string;
  tasa: Decimal | null;
  ultimos4: string | null;
  tipo: TipoTransaccion.INGRESO | TipoTransaccion.EGRESO;
  comercio: string | null;
  esTarjetaCredito: boolean;
}

/** Interpreta `datos_parseados` ({comercio, monto, moneda, ultimos_4, instrumento, tipo, tasa_cambio}). */
export function interpretarDatosParseados(datos: Record<string, unknown> | null | undefined): DatosInterpretados {
  const d = datos ?? {};
  const montoRaw = d.monto;
  const monto =
    typeof montoRaw === 'number' || typeof montoRaw === 'string' ? tryToDecimal(String(montoRaw).replace(',', '.')) : null;
  const tasaRaw = d.tasa_cambio;
  const tasa =
    typeof tasaRaw === 'number' || typeof tasaRaw === 'string' ? tryToDecimal(String(tasaRaw).replace(',', '.')) : null;
  const ultimos4Raw = d.ultimos_4;
  const ultimos4 =
    typeof ultimos4Raw === 'string' || typeof ultimos4Raw === 'number' ? String(ultimos4Raw).trim().slice(-4) : null;
  const tipoRaw = String(d.tipo ?? d.tipo_movimiento ?? '').toUpperCase();

  return {
    monto: monto && monto.greaterThan(0) ? monto : null,
    moneda: typeof d.moneda === 'string' && d.moneda.length === 3 ? d.moneda.toUpperCase() : 'COP',
    tasa: tasa && tasa.greaterThan(0) ? tasa : null,
    ultimos4: ultimos4 && /^\d{4}$/.test(ultimos4) ? ultimos4 : null,
    tipo: tipoRaw === 'INGRESO' ? TipoTransaccion.INGRESO : TipoTransaccion.EGRESO,
    comercio: typeof d.comercio === 'string' && d.comercio.trim() ? d.comercio.trim() : null,
    esTarjetaCredito: String(d.instrumento ?? '').toUpperCase() === 'TC',
  };
}

export interface ResultadoConciliacion {
  notificacion: NotificacionesCorreo;
  transaccion: Transacciones | null;
  compra: ComprasCredito | null;
  prestamoId: number | null;
  responsablesCreados: number;
}

@Injectable()
export class NotificacionesCorreoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transacciones: TransaccionesService,
    private readonly compras: ComprasCreditoService,
    private readonly responsables: ResponsablesService,
    private readonly prestamos: PrestamosService,
    private readonly config: ConfigService,
  ) {}

  list(ownerUserId: bigint, filtro: NotificacionesFiltroDto) {
    const estado = filtro.estado ?? filtro.estado_procesamiento;
    return this.prisma.notificacionesCorreo.findMany({
      where: { owner_user_id: ownerUserId, ...(estado ? { estado_procesamiento: estado } : {}) },
      orderBy: { fecha_correo: 'desc' },
      take: filtro.limit ?? 100,
    });
  }

  async get(id: number, ownerUserId: bigint): Promise<NotificacionesCorreo> {
    const n = await this.prisma.notificacionesCorreo.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!n) throw new NotFoundException(`Notificación ${id} no encontrada`);
    return n;
  }

  /**
   * Ingesta idempotente de UN correo (`ON CONFLICT (external_message_id) DO NOTHING RETURNING id`). Si los últimos
   * 4 dígitos identifican de forma única una cuenta, crea la transacción en PENDIENTE_REVISION (origen EMAIL_AUTO)
   * y la enlaza. El saldo NO se afecta hasta conciliar (Trigger 2 solo aplica CONFIRMADO).
   * Para lotes de Bancolombia ver `SyncBatchService` (`POST /notificaciones-correo/sync-batch`).
   */
  async ingestar(dto: IngestaCorreoDto, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const fechaCorreo = new Date(dto.fecha_correo);
      const notificacionId = await insertarNotificacionIdempotente(tx, {
        ownerUserId,
        externalMessageId: dto.external_message_id,
        remitente: dto.remitente,
        asunto: dto.asunto,
        fechaCorreo,
        cuerpoExtraido: dto.cuerpo_extraido,
        datosParseados: dto.datos_parseados,
      });

      if (notificacionId === null) {
        const existente = await tx.notificacionesCorreo.findUnique({ where: { external_message_id: dto.external_message_id } });
        const propia = existente && existente.owner_user_id === ownerUserId ? existente : null;
        return {
          duplicado: true,
          id: propia ? Number(propia.id) : null,
          estadoProcesamiento: propia?.estado_procesamiento ?? null,
          transaccionGeneradaId: propia?.transaccion_generada_id ? Number(propia.transaccion_generada_id) : null,
        };
      }

      const interpretado = interpretarDatosParseados(dto.datos_parseados);
      let estado: EstadoNotificacionCorreo = EstadoNotificacionCorreo.PENDIENTE;
      let transaccion: Transacciones | null = null;

      if (dto.datos_parseados && !interpretado.monto) {
        estado = EstadoNotificacionCorreo.ERROR;
      } else if (interpretado.monto && interpretado.ultimos4 && !interpretado.esTarjetaCredito) {
        const puedeConvertir = interpretado.moneda === 'COP' || interpretado.tasa !== null;
        const cuentas = await tx.cuentasFinancieras.findMany({
          where: { owner_user_id: ownerUserId, ultimos_4_digitos: interpretado.ultimos4, is_active: { not: false } },
          select: { id: true },
          take: 2,
        });
        // Solo se auto-crea si la cuenta es inequívoca; si hay 0 o >1 coincidencias queda para conciliación manual.
        if (cuentas.length === 1 && puedeConvertir) {
          const cuentaId = Number(cuentas[0].id);
          transaccion = await this.transacciones.insertar(
            tx,
            {
              tipoTransaccion: interpretado.tipo,
              cuentaOrigenId: interpretado.tipo === TipoTransaccion.EGRESO ? cuentaId : null,
              cuentaDestinoId: interpretado.tipo === TipoTransaccion.INGRESO ? cuentaId : null,
              tarjetaPagadaId: null,
              categoriaId: null,
              fechaTransaccion: fechaCorreo,
              concepto: (interpretado.comercio ?? dto.asunto ?? 'Movimiento detectado por correo').slice(0, 255),
              monedaOriginal: interpretado.moneda,
              montoOriginal: interpretado.monto.toString(),
              tasaCambio: interpretado.tasa?.toString(),
              origenRegistro: OrigenRegistro.EMAIL_AUTO,
              estado: EstadoTransaccion.PENDIENTE_REVISION,
              notas: `Generada automáticamente desde el correo ${dto.external_message_id}`,
            },
            ownerUserId,
          );
        }
      }

      const notificacion = await tx.notificacionesCorreo.update({
        where: { id: notificacionId },
        data: { estado_procesamiento: estado, transaccion_generada_id: transaccion?.id ?? null },
      });
      return {
        duplicado: false,
        id: Number(notificacion.id),
        estadoProcesamiento: notificacion.estado_procesamiento,
        transaccionGeneradaId: transaccion ? Number(transaccion.id) : null,
      };
    });
  }

  /**
   * Conciliación desde Angular. CONFIRMAR permite, según lo que generó la ingesta:
   *  • compra de TC: cambiar `numeroCuotas` (recalcula CuotasDetalle, Regla 4), asignar `responsables` (Trigger 6),
   *    corregir el concepto, o crearla con `tarjetaId` si la tarjeta no se identificó;
   *  • transacción: confirmarla (el Trigger 2 impacta el saldo), asignar `categoriaId`, corregir concepto/monto,
   *    o `convertirEnPrestamo` (egreso → préstamo POR_COBRAR; el Trigger 4 lo carga al sub-ledger);
   *  • sin generar nada: crear la transacción indicando `cuentaId`.
   * DESCARTAR anula la transacción pendiente / elimina la compra importada. Todo en UNA transacción.
   */
  async conciliar(id: number, dto: ConciliarCorreoDto, ownerUserId: bigint): Promise<ResultadoConciliacion> {
    return this.prisma.$transaction(async (tx) => {
      const notificacion = await tx.notificacionesCorreo.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!notificacion) throw new NotFoundException(`Notificación ${id} no encontrada`);
      // Lo que el sync resolvió solo (tiene `vinculo`) se puede DESHACER descartándolo; confirmar de nuevo no tiene sentido.
      const deshacerAutomatico =
        (dto.accion ?? 'CONFIRMAR') === 'DESCARTAR' && notificacion.estado_procesamiento === EstadoNotificacionCorreo.CONCILIADO && (notificacion.vinculo ?? null) !== null;
      if (
        !deshacerAutomatico &&
        (notificacion.estado_procesamiento === EstadoNotificacionCorreo.CONCILIADO ||
          notificacion.estado_procesamiento === EstadoNotificacionCorreo.IGNORADO)
      ) {
        throw new ConflictException(`La notificación ya fue ${notificacion.estado_procesamiento?.toLowerCase()}`);
      }

      const transaccionActual = notificacion.transaccion_generada_id
        ? await tx.transacciones.findFirst({ where: { id: notificacion.transaccion_generada_id, owner_user_id: ownerUserId } })
        : null;
      const compraActual = notificacion.compra_credito_generada_id
        ? await tx.comprasCredito.findFirst({ where: { id: notificacion.compra_credito_generada_id, owner_user_id: ownerUserId } })
        : null;

      if ((dto.accion ?? 'CONFIRMAR') === 'DESCARTAR') {
        return this.descartar(tx, notificacion, transaccionActual, compraActual, ownerUserId);
      }

      let transaccion: Transacciones | null = null;
      let compra: ComprasCredito | null = null;
      let responsablesCreados = 0;

      if (compraActual) {
        ({ compra, responsablesCreados } = await this.ajustarCompra(tx, compraActual, dto, ownerUserId));
      } else if (transaccionActual) {
        transaccion = await this.confirmarExistente(tx, transaccionActual, dto, ownerUserId);
      } else if (dto.tarjetaId !== undefined) {
        compra = await this.crearCompraDesdeNotificacion(tx, notificacion, dto, ownerUserId);
        ({ compra, responsablesCreados } = await this.ajustarCompra(tx, compra, dto, ownerUserId, true));
      } else {
        transaccion = await this.crearConfirmada(tx, notificacion, dto, ownerUserId);
      }

      let prestamoId: number | null = null;
      if (dto.convertirEnPrestamo) {
        if (!transaccion) {
          throw datosInvalidos({ convertirEnPrestamo: ['Solo se puede convertir en préstamo una notificación con transacción de egreso'] });
        }
        prestamoId = await this.convertirEnPrestamo(tx, transaccion, dto, ownerUserId);
      }

      const actualizada = await tx.notificacionesCorreo.update({
        where: { id: notificacion.id },
        data: {
          estado_procesamiento: EstadoNotificacionCorreo.CONCILIADO,
          transaccion_generada_id: transaccion?.id ?? notificacion.transaccion_generada_id,
          compra_credito_generada_id: compra?.id ?? notificacion.compra_credito_generada_id,
        },
      });
      return { notificacion: actualizada, transaccion, compra, prestamoId, responsablesCreados };
    }, TX_OPTIONS);
  }

  // ───────────────────────────── conciliación: pasos ─────────────────────────────

  private async descartar(
    tx: Tx,
    notificacion: NotificacionesCorreo,
    transaccionActual: Transacciones | null,
    compraActual: ComprasCredito | null,
    ownerUserId: bigint,
  ): Promise<ResultadoConciliacion> {
    let transaccion = transaccionActual;
    // Solo se deshace lo que la app CREÓ por este correo: lo que ya existía (vínculo EXISTENTE) o es de otro correo no se toca.
    const vinculo = notificacion.vinculo ?? null;
    const creadaPorEsteCorreo = vinculo === null || vinculo === 'CREADA';
    const anulable =
      transaccionActual?.estado === EstadoTransaccion.PENDIENTE_REVISION ||
      (transaccionActual?.estado === EstadoTransaccion.CONFIRMADO && vinculo === 'CREADA'); // la confirmó el sync, no el usuario
    if (transaccionActual && creadaPorEsteCorreo && anulable) {
      transaccion = await tx.transacciones.update({ where: { id: transaccionActual.id }, data: { estado: EstadoTransaccion.ANULADO } });
    }
    if (compraActual && creadaPorEsteCorreo) await this.compras.deleteTx(tx, Number(compraActual.id), ownerUserId);
    const actualizada = await tx.notificacionesCorreo.update({
      where: { id: notificacion.id },
      data: {
        estado_procesamiento: EstadoNotificacionCorreo.IGNORADO,
        // El correo deja de reclamar la compra/transacción: queda libre para enlazarse a otro o seguir sola.
        ...(creadaPorEsteCorreo ? {} : { compra_credito_generada_id: null, transaccion_generada_id: null }),
      },
    });
    return { notificacion: actualizada, transaccion, compra: null, prestamoId: null, responsablesCreados: 0 };
  }

  /** Compra de TC importada: cuotas, concepto y responsables. */
  private async ajustarCompra(
    tx: Tx,
    compraInicial: ComprasCredito,
    dto: ConciliarCorreoDto,
    ownerUserId: bigint,
    recienCreada = false,
  ): Promise<{ compra: ComprasCredito; responsablesCreados: number }> {
    if (dto.monto !== undefined && !recienCreada) {
      throw datosInvalidos({ monto: ['El monto de una compra importada no se edita aquí: descártala y regístrala de nuevo'] });
    }
    let compra = compraInicial;

    if (dto.concepto !== undefined && dto.concepto !== compra.concepto) {
      compra = await tx.comprasCredito.update({ where: { id: compra.id }, data: { concepto: dto.concepto } });
    }
    if (dto.numeroCuotas !== undefined && dto.numeroCuotas !== compra.numero_cuotas) {
      compra = await this.compras.cambiarNumeroCuotasTx(tx, compra.id, dto.numeroCuotas, ownerUserId);
    }

    const nuevos = dto.responsables ?? [];
    if (nuevos.length > 0) {
      const existentes = await tx.responsablesComprasCredito.findMany({
        where: { compra_credito: compra.id },
        select: { porcentaje_pago: true },
      });
      const total = sumDecimals([...existentes.map((r) => r.porcentaje_pago), ...nuevos.map((r) => r.porcentajePago)]);
      if (total.greaterThan(100)) {
        throw datosInvalidos({ responsables: [`La suma de porcentajes de los responsables (${total.toString()}) no puede superar 100`] });
      }
      const valorCompra = toDecimal(compra.valor_compra);
      for (const r of nuevos) {
        const porcentaje = rate(toDecimal(r.porcentajePago));
        await this.responsables.createTx(
          tx,
          {
            persona: r.personaId,
            porcentajePago: porcentaje.toString(),
            cantidadPago: money(valorCompra.mul(porcentaje).div(100)).toString(),
            cantidadCuotas: r.cantidadCuotas ?? compra.numero_cuotas ?? 1,
            compraCredito: Number(compra.id),
          },
          ownerUserId,
        );
      }
    }
    return { compra, responsablesCreados: nuevos.length };
  }

  private async confirmarExistente(tx: Tx, actual: Transacciones, dto: ConciliarCorreoDto, ownerUserId: bigint): Promise<Transacciones> {
    const data: Prisma.TransaccionesUncheckedUpdateInput = { estado: EstadoTransaccion.CONFIRMADO };
    if (dto.categoriaId !== undefined) data.categoria_id = await assertCategoria(tx, dto.categoriaId, ownerUserId);
    if (dto.concepto !== undefined) data.concepto = dto.concepto;
    if (dto.notas !== undefined) data.notas = dto.notas;
    if (dto.monto !== undefined) {
      if (actual.moneda_original !== 'COP') {
        throw datosInvalidos({ monto: ['Solo se puede corregir el monto de transacciones en COP'] });
      }
      data.monto_original = toDbMoney(money(toDecimal(dto.monto)));
      data.monto_cop = toDbMoney(money(toDecimal(dto.monto)));
    }
    return tx.transacciones.update({ where: { id: actual.id }, data });
  }

  private async crearConfirmada(tx: Tx, notificacion: NotificacionesCorreo, dto: ConciliarCorreoDto, ownerUserId: bigint): Promise<Transacciones> {
    if (dto.cuentaId === undefined) {
      throw datosInvalidos({ cuentaId: ['cuentaId es obligatoria: la ingesta no pudo identificar la cuenta'] });
    }
    await assertCuenta(tx, dto.cuentaId, ownerUserId);
    const interpretado = interpretarDatosParseados(notificacion.datos_parseados as Record<string, unknown> | null);
    const monto = dto.monto !== undefined ? toDecimal(dto.monto) : interpretado.monto;
    if (!monto) throw datosInvalidos({ monto: ['monto es obligatorio: no se pudo leer del correo'] });
    if (interpretado.moneda !== 'COP' && !interpretado.tasa) {
      throw datosInvalidos({ monto: [`El correo está en ${interpretado.moneda} sin tasa de cambio`] });
    }

    return this.transacciones.insertar(
      tx,
      {
        tipoTransaccion: interpretado.tipo,
        cuentaOrigenId: interpretado.tipo === TipoTransaccion.EGRESO ? dto.cuentaId : null,
        cuentaDestinoId: interpretado.tipo === TipoTransaccion.INGRESO ? dto.cuentaId : null,
        tarjetaPagadaId: null,
        categoriaId: dto.categoriaId ?? null,
        fechaTransaccion: notificacion.fecha_correo,
        concepto: (dto.concepto ?? interpretado.comercio ?? notificacion.asunto ?? 'Movimiento por correo').slice(0, 255),
        monedaOriginal: interpretado.moneda,
        montoOriginal: monto.toString(),
        tasaCambio: interpretado.tasa?.toString(),
        origenRegistro: OrigenRegistro.EMAIL_AUTO,
        estado: EstadoTransaccion.CONFIRMADO,
        notas: dto.notas ?? `Conciliada desde el correo ${notificacion.external_message_id}`,
      },
      ownerUserId,
    );
  }

  /** Compra a 1 cuota para una notificación de TC cuya tarjeta no se pudo identificar automáticamente. */
  private async crearCompraDesdeNotificacion(
    tx: Tx,
    notificacion: NotificacionesCorreo,
    dto: ConciliarCorreoDto,
    ownerUserId: bigint,
  ): Promise<ComprasCredito> {
    const datos = (notificacion.datos_parseados ?? {}) as Record<string, unknown>;
    const interpretado = interpretarDatosParseados(datos);
    const monto = dto.monto !== undefined ? toDecimal(dto.monto) : interpretado.monto;
    if (!monto) throw datosInvalidos({ monto: ['monto es obligatorio: no se pudo leer del correo'] });

    const fechaTexto = typeof datos.fecha === 'string' ? datos.fecha : formatIsoDate(truncateToDay(notificacion.fecha_correo));
    const fechaCompra = parseIsoDate(fechaTexto.slice(0, 10));
    if (!fechaCompra) throw datosInvalidos({ fecha: ['La fecha del correo no es válida'] });

    let usd: { tasa: string } | null = null;
    if (interpretado.moneda === 'USD') {
      const respaldo = this.config.get<string | number>('DEFAULT_TRM_USD');
      const tasa = await resolverTrmUsd(tx, ownerUserId, respaldo ? rate(toDecimal(respaldo)) : null);
      if (!tasa) throw datosInvalidos({ monto: ['No hay TRM disponible para una compra en USD (configura DEFAULT_TRM_USD)'] });
      usd = { tasa: tasa.toString() };
    }

    const id = await this.compras.saveTx(
      tx,
      {
        concepto: (dto.concepto ?? interpretado.comercio ?? notificacion.asunto ?? 'Compra Bancolombia').slice(0, 255),
        valorCompra: usd ? undefined : monto.toString(),
        fechaCompra,
        numeroCuotas: 1,
        interes: 0,
        descripcion: `Conciliada desde el correo ${notificacion.external_message_id}`,
        estado: 'Pendiente',
        tarjeta: BigInt(dto.tarjetaId as number),
        plasticoUltimos4: typeof datos.ultimos_4 === 'string' && /^\d{4}$/.test(datos.ultimos_4) ? datos.ultimos_4 : null,
        ...(usd ? { monedaOriginal: 'USD', valorMonedaOriginal: monto.toString(), tasaCambioAplicada: usd.tasa, trmConfirmada: false } : {}),
      },
      ownerUserId,
    );
    return tx.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(id) } });
  }

  private async convertirEnPrestamo(tx: Tx, transaccion: Transacciones, dto: ConciliarCorreoDto, ownerUserId: bigint): Promise<number> {
    const p = dto.convertirEnPrestamo as NonNullable<ConciliarCorreoDto['convertirEnPrestamo']>;
    if (transaccion.tipo_transaccion !== TipoTransaccion.EGRESO && transaccion.tipo_transaccion !== TipoTransaccion.TRANSFERENCIA) {
      throw datosInvalidos({ convertirEnPrestamo: ['Solo un egreso o transferencia puede convertirse en préstamo'] });
    }
    const fechaTransaccion = formatIsoDate(truncateToDay(transaccion.fecha_transaccion));
    return this.prestamos.createTx(
      tx,
      {
        valorPrestado: transaccion.monto_cop.toString(),
        concepto: transaccion.concepto,
        fechaCobro: p.fechaCobro ?? fechaTransaccion,
        responsable: p.responsableId,
        estado: 'Pendiente',
        comentarios: [p.comentarios, `Originado en la transacción #${transaccion.id}`].filter(Boolean).join(' · '),
        fechaPrestamo: fechaTransaccion,
        metodo: p.metodo,
      },
      ownerUserId,
    );
  }
}
