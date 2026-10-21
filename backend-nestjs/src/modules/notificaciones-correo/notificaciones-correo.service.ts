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
import { inferirPrefillPorHistorial, PrefillConciliacionSugerido } from '../sugerencias/sugerencias.util';
import { cuentasConDebitos, soloCredito } from '../tarjetas/tipos-tarjeta.util';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { extraerUltimos4, parseMontoBancolombia } from './bancolombia-normalizer.util';
import { clasificarIntencionCorreo } from './clasificador-correo.util';
import { interpretarCuerpo } from './cuerpo-correo.util';
import { ConciliarCorreoDto, IngestaCorreoDto, NotificacionesFiltroDto } from './dto/notificacion.dto';
import { insertarNotificacionIdempotente, resolverTrmUsd } from './notificaciones.repository';
import { encontrarPersona } from './persona-match.util';

export type { PrefillConciliacionSugerido };

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

/**
 * Instante del movimiento: el del correo, salvo que el usuario corrija el DÍA. Entonces se conserva la hora del correo si el día
 * indicado es el mismo (Bogotá, UTC-5) y, si cambia, se usa el mediodía de ese día para que ninguna zona horaria lo corra de fecha.
 */
export function instanteDelMovimiento(fecha: string | undefined, correo: Date): Date {
  if (fecha === undefined) return correo;
  if (!parseIsoDate(fecha)) throw datosInvalidos({ fecha: ['La fecha no es válida'] });
  const diaDelCorreo = new Date(correo.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
  return diaDelCorreo === fecha ? correo : new Date(`${fecha}T12:00:00-05:00`);
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
   * Smart Pre-fill (Iteración 2 — Fase 3): calcula los campos sugeridos para conciliar un correo en 1 clic,
   * combinando los datos extraídos del correo/cuerpo con la moda estadística del historial (últimas 15 compras/movimientos
   * del mismo comercio canónico) y la detección de registros existentes en ventana de ±72h.
   */
  async calcularPrefillInteligente(id: number, ownerUserId: bigint): Promise<PrefillConciliacionSugerido> {
    const notificacion = await this.get(id, ownerUserId);
    const datos = (notificacion.datos_parseados ?? {}) as Record<string, unknown>;
    const interpretado = interpretarDatosParseados(datos);
    const cuerpo = interpretarCuerpo(notificacion.cuerpo_extraido);

    const monto =
      interpretado.monto ??
      (notificacion.monto_original ? toDecimal(notificacion.monto_original) : null) ??
      parseMontoBancolombia(notificacion.cuerpo_extraido ?? '');

    const ultimos4 =
      interpretado.ultimos4 ??
      notificacion.ultimos_4 ??
      cuerpo.ultimos4 ??
      extraerUltimos4(`${notificacion.cuerpo_extraido ?? ''} ${notificacion.asunto ?? ''}`);

    const contraparteNombre = cuerpo.enviada?.contraparte ?? cuerpo.recibida?.contraparte ?? null;
    const contraparteLlave = cuerpo.enviada?.llave ?? cuerpo.recibida?.llave ?? null;

    const comercioCrudo =
      interpretado.comercio ??
      contraparteNombre ??
      notificacion.comercio_normalizado ??
      notificacion.asunto ??
      null;

    const esTarjetaCredito =
      interpretado.esTarjetaCredito ||
      notificacion.tarjeta_id !== null ||
      /t\.?\s*cred|tarjeta de cr[eé]dito/i.test(notificacion.cuerpo_extraido ?? '');

    const [cuentasBase, todasTarjetas, personas, compras, transacciones] = await Promise.all([
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId, is_active: { not: false } },
        select: { id: true, ultimos_4_digitos: true, moneda: true, es_principal: true },
      }),
      this.prisma.tarjetas.findMany({
        where: { owner_user_id: ownerUserId },
      }),
      this.prisma.personas.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, nombre: true, numero_celular: true },
      }),
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId, concepto: { not: null } },
        select: {
          id: true,
          concepto: true,
          valor_compra: true,
          numero_cuotas: true,
          tarjeta: true,
          fecha_compra: true,
          notificaciones: { select: { id: true }, take: 1 },
          responsables: {
            select: { persona: true, porcentaje_pago: true, cantidad_cuotas: true },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: [{ fecha_compra: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      this.prisma.transacciones.findMany({
        where: { owner_user_id: ownerUserId, estado: { not: EstadoTransaccion.ANULADO } },
        select: {
          id: true,
          concepto: true,
          monto_cop: true,
          categoria_id: true,
          cuenta_origen_id: true,
          fecha_transaccion: true,
          notificaciones: { select: { id: true }, take: 1 },
        },
        orderBy: [{ fecha_transaccion: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
    ]);

    const tarjetasCredito = soloCredito(todasTarjetas);
    const cuentas = cuentasConDebitos(cuentasBase, todasTarjetas);

    const tarjetaPorDigitos = ultimos4
      ? tarjetasCredito.filter((t) => t.ultimos_4_digitos === ultimos4)
      : [];
    const cuentaPorDigitos = ultimos4
      ? cuentas.filter((c) => c.ultimos_4_digitos === ultimos4)
      : [];

    const tarjetaDirectaId =
      notificacion.tarjeta_id !== null && notificacion.tarjeta_id !== undefined
        ? Number(notificacion.tarjeta_id)
        : tarjetaPorDigitos.length === 1
          ? Number(tarjetaPorDigitos[0].id)
          : null;

    const cuentaDirectaId =
      notificacion.cuenta_id !== null && notificacion.cuenta_id !== undefined
        ? Number(notificacion.cuenta_id)
        : cuentaPorDigitos.length === 1
          ? Number(cuentaPorDigitos[0].id)
          : null;

    const cuentaPrincipal = cuentas.find((c) => c.es_principal === true) ?? cuentas[0] ?? null;
    const personaContraparte = encontrarPersona(
      personas,
      contraparteNombre ?? interpretado.comercio ?? null,
      contraparteLlave,
    );

    return inferirPrefillPorHistorial({
      notificacionId: id,
      comercioCrudo,
      asunto: notificacion.asunto,
      monto: monto ? Number(monto.toString()) : null,
      moneda: interpretado.moneda || notificacion.moneda || 'COP',
      fechaCorreo: notificacion.fecha_correo,
      ultimos4,
      esTarjetaCredito,
      tarjetaDirectaId,
      cuentaDirectaId,
      cuentaPrincipalId: cuentaPrincipal ? Number(cuentaPrincipal.id) : null,
      personaContraparteId: personaContraparte ? Number(personaContraparte.id) : null,
      compras: compras.map((c) => ({
        id: Number(c.id),
        concepto: c.concepto,
        valor: c.valor_compra === null ? null : Number(c.valor_compra),
        numeroCuotas: c.numero_cuotas,
        tarjetaId: c.tarjeta === null ? null : Number(c.tarjeta),
        fecha: c.fecha_compra,
        personas: c.responsables
          .map((r) => (r.persona === null ? null : Number(r.persona)))
          .filter((p): p is number => p !== null),
        responsablesDetalle: c.responsables
          .filter((r): r is typeof r & { persona: bigint } => r.persona !== null)
          .map((r) => ({
            personaId: Number(r.persona),
            porcentajePago: toDecimal(r.porcentaje_pago).toFixed(2),
            cantidadCuotas: r.cantidad_cuotas,
          })),
        vinculada: c.notificaciones.length > 0,
      })),
      movimientos: transacciones.map((t) => ({
        id: Number(t.id),
        concepto: t.concepto,
        valor: t.monto_cop === null ? null : Number(t.monto_cop),
        categoriaId: t.categoria_id === null ? null : Number(t.categoria_id),
        cuentaId: t.cuenta_origen_id === null ? null : Number(t.cuenta_origen_id),
        fecha: t.fecha_transaccion,
        vinculada: t.notificaciones.length > 0,
      })),
    });
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
      const cuerpo = interpretarCuerpo(dto.cuerpo_extraido);
      const clasif = clasificarIntencionCorreo([dto.asunto, interpretado.comercio, dto.cuerpo_extraido]);
      const esRechazada = cuerpo.rechazada || clasif.tipoIntencion === 'TRANSACCION_RECHAZADA';

      if (esRechazada) {
        const motivoRechazo = cuerpo.patronRechazo ?? clasif.patronRechazo ?? 'compra_rechazada_o_no_exitosa';
        const datosActualizados = {
          ...(dto.datos_parseados ?? {}),
          es_compra_valida: false,
          tipo_intencion: 'TRANSACCION_RECHAZADA',
          motivo_rechazo: motivoRechazo,
        } as Prisma.InputJsonObject;
        const notificacion = await tx.notificacionesCorreo.update({
          where: { id: notificacionId },
          data: {
            estado_procesamiento: EstadoNotificacionCorreo.DESCARTADO_RECHAZADO,
            transaccion_generada_id: null,
            compra_credito_generada_id: null,
            datos_parseados: datosActualizados,
          },
        });
        return {
          duplicado: false,
          id: Number(notificacion.id),
          estadoProcesamiento: notificacion.estado_procesamiento,
          transaccionGeneradaId: null,
        };
      }

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
  async conciliar(id: number, dtoEntrada: ConciliarCorreoDto, ownerUserId: bigint): Promise<ResultadoConciliacion> {
    return this.prisma.$transaction(async (tx) => {
      const notificacion = await tx.notificacionesCorreo.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!notificacion) throw new NotFoundException(`Notificación ${id} no encontrada`);
      const dto = await this.resolverProducto(tx, dtoEntrada, ownerUserId);
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
        prestamoId = await this.convertirEnPrestamo(tx, transaccion, dto, ownerUserId, notificacion.id);
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

  /**
   * El selector unificado de la pantalla envía `tarjetaId` para CUALQUIER tarjeta. Una de crédito crea la compra; una de débito es
   * un movimiento de su cuenta (se registra en esa cuenta, como si se hubiera elegido la cuenta). Una tarjeta ajena no existe.
   */
  private async resolverProducto(tx: Tx, dto: ConciliarCorreoDto, ownerUserId: bigint): Promise<ConciliarCorreoDto> {
    if (dto.tarjetaId === undefined) return dto;
    const tarjeta = await tx.tarjetas.findFirst({ where: { id: BigInt(dto.tarjetaId), owner_user_id: ownerUserId }, select: { tipo_tarjeta: true, cuenta_id: true } });
    if (!tarjeta) throw new NotFoundException(`Tarjeta ${dto.tarjetaId} no encontrada`);
    if (tarjeta.tipo_tarjeta !== 'DEBITO') return dto;
    if (tarjeta.cuenta_id === null) throw datosInvalidos({ tarjetaId: ['La tarjeta de débito no tiene cuenta asociada: asígnale una en Tarjetas'] });
    return { ...dto, tarjetaId: undefined, cuentaId: dto.cuentaId ?? Number(tarjeta.cuenta_id) };
  }

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
    if (dto.fecha !== undefined && !recienCreada) {
      throw datosInvalidos({ fecha: ['La fecha de una compra importada no se edita aquí: descártala y regístrala de nuevo'] });
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
    if (dto.fecha !== undefined) throw datosInvalidos({ fecha: ['La fecha de un movimiento ya registrado no se edita aquí'] });
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
    const tasa = interpretado.moneda === 'COP' ? null : (interpretado.tasa ?? (dto.tasaCambio !== undefined ? toDecimal(dto.tasaCambio) : null));
    if (interpretado.moneda !== 'COP' && !tasa) {
      throw datosInvalidos({ tasaCambio: [`El correo está en ${interpretado.moneda} y no trae tasa de cambio: indica la TRM (cuántos pesos vale cada ${interpretado.moneda})`] });
    }

    return this.transacciones.insertar(
      tx,
      {
        tipoTransaccion: interpretado.tipo,
        cuentaOrigenId: interpretado.tipo === TipoTransaccion.EGRESO ? dto.cuentaId : null,
        cuentaDestinoId: interpretado.tipo === TipoTransaccion.INGRESO ? dto.cuentaId : null,
        tarjetaPagadaId: null,
        categoriaId: dto.categoriaId ?? null,
        fechaTransaccion: instanteDelMovimiento(dto.fecha, notificacion.fecha_correo),
        concepto: (dto.concepto ?? interpretado.comercio ?? notificacion.asunto ?? 'Movimiento por correo').slice(0, 255),
        monedaOriginal: interpretado.moneda,
        montoOriginal: monto.toString(),
        tasaCambio: tasa?.toString(),
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

    const fechaTexto = dto.fecha ?? (typeof datos.fecha === 'string' ? datos.fecha : formatIsoDate(truncateToDay(notificacion.fecha_correo)));
    const fechaCompra = parseIsoDate(fechaTexto.slice(0, 10));
    if (!fechaCompra) throw datosInvalidos({ fecha: ['La fecha del correo no es válida'] });

    let usd: { tasa: string } | null = null;
    if (interpretado.moneda === 'USD') {
      // La que indica el usuario manda; si no, la de la última compra en dólares o la configurada (DEFAULT_TRM_USD).
      const respaldo = this.config.get<string | number>('DEFAULT_TRM_USD');
      const tasa = dto.tasaCambio !== undefined ? rate(toDecimal(dto.tasaCambio)) : await resolverTrmUsd(tx, ownerUserId, respaldo ? rate(toDecimal(respaldo)) : null);
      if (!tasa) throw datosInvalidos({ tasaCambio: ['Es una compra en dólares y no hay una TRM disponible: indica la TRM (cuántos pesos vale cada dólar)'] });
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

  private async convertirEnPrestamo(tx: Tx, transaccion: Transacciones, dto: ConciliarCorreoDto, ownerUserId: bigint, notificacionId?: bigint): Promise<number> {
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
        transaccionDesembolsoId: Number(transaccion.id),
        ...(notificacionId ? { notificacionCorreoId: Number(notificacionId) } : {}),
        ...(transaccion.cuenta_origen_id ? { cuentaOrigenDesembolsoId: Number(transaccion.cuenta_origen_id) } : {}),
      },
      ownerUserId,
    );
  }
}
