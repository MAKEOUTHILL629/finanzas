import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ComprasCredito, Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import {
  calcularAmortizacion,
  calcularPagoMensualTotal,
  CuotaCalculada,
} from '../../common/utils/calculadora-amortizacion.util';
import { calcularAmortizacionFrancesa } from '../../common/utils/amortizacion-francesa.util';
import { parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, rate, sumDecimals, toDb, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { dateToMillis, idNum, num, numOrNull, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { colorSugeridoTag, nombreLegibleTag } from '../lookup/lookup.service';
import {
  inferirComercioYTags,
  normalizarComercio,
  normalizarTags,
  resolverComercioCanonicoCompra,
  sonComerciosSimilaresEstrictos,
} from '../notificaciones-correo/comercio.util';
import { resolverPlasticoCompra } from '../tarjetas/plasticos.db';
import { CompraCreditoInput, PropagarEdicionSimilaresDto } from './dto/compra-credito.dto';

type Tx = Prisma.TransactionClient;

/** Las transacciones interactivas recalculan decenas de cuotas: se amplía el timeout por defecto (5 s). */
export const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

export const ESTADO_AJUSTE_INTERES = 'Ajuste Interes';
const MARCA_AJUSTE_INTERES = 'AJUSTE DE INTERES';

interface ValoresCompra {
  moneda: string;
  fechaCompra: Date;
  valorCompra: Decimal;
  valorOriginal: Decimal;
  tasa: Decimal;
  trmConfirmada: boolean;
  interes: Decimal;
}

/** Lo que se puede cambiar en línea desde el detalle: solo lo que viene. */
export interface PatchCompraCreditoInput {
  concepto?: string;
  descripcion?: string;
  estado?: string;
  plasticoId?: number;
  valorCompra?: number | string;
  fechaCompra?: string;
  numeroCuotas?: number;
  interes?: number | string;
  tarjeta?: number;
  tags?: string[];
  comercioCanonico?: string | null;
}

/** Forma JSON idéntica a `Json.writes[CompraCredito]` del legacy (+ campos multimoneda como extra). */
export interface CompraCreditoJson {
  id: number;
  fechaCreacion: number | null;
  concepto: string | null;
  valorCompra: number;
  fechaCompra: number | null;
  numeroCuotas: number;
  fechaUltimaCuota: number | null;
  pagoMensual: number;
  interes: number;
  descripcion: string | null;
  estado: string | null;
  tarjeta: number;
  responsables: string;
  porcentajePago: number;
  monedaOriginal: string;
  valorMonedaOriginal: number | null;
  tasaCambioAplicada: number | null;
  trmConfirmada: boolean | null;
  /** Plástico guardado en la compra (NULL en las anteriores a sql/004: el historial de la tarjeta lo deduce por fecha). */
  plasticoId: number | null;
  plasticoUltimos4: string | null;
  /** La compra maestra que la unificó en un refinanciamiento (NULL = no fue unificada). */
  refinanciamientoId: number | null;
  /** La compra ES la obligación nueva de un refinanciamiento. */
  esRefinanciamiento: boolean;
  /** Capital pendiente que se llevó la maestra (solo en las unificadas). */
  saldoRefinanciado: number | null;
  /** CAPITAL_FIJO (compras normales) | FRANCES (cuota fija: los refinanciamientos). */
  sistemaAmortizacion: string;
  cuotaFijaPactada: number | null;
  /** Tags transversales (Fase 2, sql/011). */
  tags: string[];
  comercioCanonico: string | null;
}

export type EstadoRealCuota = 'PAGADA' | 'EN_EXTRACTO_ACTUAL' | 'FUTURA' | 'ABSORBIDA_REFINANCIAMIENTO';

export interface DetalleCompletoCompraCredito {
  compra: CompraCreditoJson;
  tarjeta: {
    id: number;
    nombre: string;
    franquicia: string | null;
    descripcion: string | null;
    etiqueta: string;
    ultimos4Activo: string | null;
    diaCorte: number | null;
    diaLimitePago: number | null;
    tasaInteresCompra: number | null;
    cupoTotal: number | null;
  } | null;
  plastico: {
    id: number;
    ultimos4: string;
    esActivo: boolean;
    vigenteDesde: string | null;
    vigenteHasta: string | null;
    tipo: string;
  } | null;
  cuotas: Array<{
    id: number;
    numeroCuota: number;
    fechaPago: number | null;
    fechaPagoIso: string | null;
    saldoRestante: number;
    interesPagado: number;
    aporteCapital: number;
    pagoTotal: number;
    estado: string | null;
    estadoReal: EstadoRealCuota;
    periodoFacturacion: string | null;
  }>;
  responsables: Array<{
    id: number;
    personaId: number | null;
    nombre: string;
    iniciales: string | null;
    color: string | null;
    esPropia: boolean;
    porcentajePago: number;
    cantidadPago: number;
    cantidadCuotas: number;
    estadoCobroLiquidacion: 'COBRADO' | 'EN_LIQUIDACION' | 'PENDIENTE' | 'PROPIO';
    montoCobrado: number;
  }>;
  notificacionCorreo: {
    id: number;
    externalMessageId: string;
    remitente: string | null;
    asunto: string | null;
    fechaCorreo: string;
    cuerpoExtraido: string | null;
    datosParseados: unknown;
    estadoProcesamiento: string | null;
    ultimos4: string | null;
    comercioNormalizado: string | null;
    montoOriginal: number | null;
    moneda: string | null;
    vinculo: string | null;
  } | null;
  refinanciamiento: {
    id: number;
    concepto: string | null;
    esMaestra: boolean;
    maestraId: number;
    fechaCompra: string | null;
    saldoUnificado: number;
    numeroCuotas: number;
    tasaMensual: number;
    cuotaMensual: number;
    sistemaAmortizacion: string;
    absorbidasCount: number;
  } | null;
  recurrencia: {
    id: number;
    plantillaId: number;
    nombre: string;
    frecuencia: string | null;
    montoBaseEstimado: number;
    ultimoPeriodo: string | null;
    activa: boolean;
  } | null;
  estadisticasComercio: {
    comercioCanonico: string;
    totalHistoricoAnio: number;
    cantidadComprasAnio: number;
    gastoMesTarjeta: number;
    porcentajeSobreGastoMesTarjeta: number;
  };
  resumenPagoUnico: {
    esUnaCuota: boolean;
    fechaTransaccion: string | null;
    fechaEstimadaPagoExtracto: string | null;
    costoFinanciero: number;
    gastoMesTarjeta: number;
    porcentajeSobreGastoMesTarjeta: number;
  };
}

@Injectable()
export class ComprasCreditoService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── Lecturas ─────────────────────────────

  /** `GET /api/compras-credito` — incluye `responsables` ("1,2") y `porcentajePago` (Σ), como el JOIN legacy. */
  async list(ownerUserId: bigint): Promise<CompraCreditoJson[]> {
    const compras = await this.prisma.comprasCredito.findMany({
      where: { owner_user_id: ownerUserId },
      include: {
        responsables: { select: { persona: true, porcentaje_pago: true }, orderBy: { id: 'asc' } },
        plastico: { select: { ultimos_4: true } },
      },
      orderBy: { id: 'asc' },
    });
    return compras.map((c) =>
      this.toJson(
        c,
        c.responsables
          .map((r) => r.persona)
          .filter((p): p is bigint => p !== null)
          .join(','),
        sumDecimals(c.responsables.map((r) => r.porcentaje_pago)).toNumber(),
        c.plastico?.ultimos_4 ?? null,
      ),
    );
  }

  /** `GET /api/compras-credito/detalle/:id` — `null` si no existe (Json.toJson(None)). */
  async getById(id: number, ownerUserId: bigint): Promise<CompraCreditoJson | null> {
    const compra = await this.prisma.comprasCredito.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      include: { plastico: { select: { ultimos_4: true } } },
    });
    return compra ? this.toJson(compra, '', 0, compra.plastico?.ultimos_4 ?? null) : null;
  }

  /**
   * `GET /api/v2/compras-credito/:id/detalle-completo` — Fase 1 (Iteración 3):
   * Devuelve el inspector financiero 360° en una sola consulta con trazabilidad de tarjeta/plástico,
   * responsables con estado de cobro, correo bancario original, refinanciamiento, recurrencia,
   * estadísticas anuales del comercio y resumen de pago único al corte.
   */
  async getDetalleCompleto(id: number, ownerUserId: bigint, hoy: Date = todayLocal()): Promise<DetalleCompletoCompraCredito | null> {
    const compra = await this.prisma.comprasCredito.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      include: {
        tarjeta_ref: {
          include: {
            plasticos: { orderBy: { id: 'desc' } },
          },
        },
        plastico: true,
        cuotas: { orderBy: { numero_cuota: 'asc' } },
        responsables: {
          include: {
            persona_ref: true,
            movimientos: true,
          },
          orderBy: { id: 'asc' },
        },
        notificaciones: {
          orderBy: { fecha_correo: 'desc' },
          take: 1,
        },
        periodos_pagados: {
          include: { plantilla: true },
          orderBy: { periodo: 'desc' },
          take: 1,
        },
        refinanciamiento: {
          include: { _count: { select: { absorbidas: true } } },
        },
        absorbidas: {
          select: { id: true },
        },
      },
    });
    if (!compra) return null;

    const responsablesCsv = (compra.responsables ?? [])
      .map((r) => r.persona)
      .filter((p): p is bigint => p !== null)
      .join(',');
    const porcentajeTotal = sumDecimals((compra.responsables ?? []).map((r) => r.porcentaje_pago)).toNumber();
    const compraJson = this.toJson(compra, responsablesCsv, porcentajeTotal, compra.plastico?.ultimos_4 ?? null);

    // 1. Tarjeta y plástico
    const tRef = compra.tarjeta_ref;
    const activo = tRef?.plasticos?.find((p) => p.es_activo)?.ultimos_4 ?? tRef?.ultimos_4_digitos?.split(',')[0] ?? null;
    const nombreTarjeta = tRef ? [tRef.franquicia, tRef.descripcion].filter(Boolean).join(' · ') || `Tarjeta #${tRef.id}` : null;
    const tarjetaInfo = tRef
      ? {
          id: idNum(tRef.id),
          nombre: nombreTarjeta!,
          franquicia: tRef.franquicia,
          descripcion: tRef.descripcion,
          etiqueta: `${(tRef.es_generica ? tRef.alias : null) || tRef.franquicia || nombreTarjeta}${activo ? ` ··${activo}` : ''}`,
          ultimos4Activo: activo,
          diaCorte: tRef.dia_corte,
          diaLimitePago: tRef.dia_limite_pago,
          tasaInteresCompra: numOrNull(tRef.tasa_interes_compra),
          cupoTotal: numOrNull(tRef.cupo_total),
        }
      : null;

    const pRef = compra.plastico;
    const plasticoInfo = pRef
      ? {
          id: idNum(pRef.id),
          ultimos4: pRef.ultimos_4,
          esActivo: pRef.es_activo,
          vigenteDesde: pRef.vigente_desde ? pRef.vigente_desde.toISOString().slice(0, 10) : null,
          vigenteHasta: pRef.vigente_hasta ? pRef.vigente_hasta.toISOString().slice(0, 10) : null,
          tipo: (pRef.notas ?? '').toLowerCase().includes('virtual') ? 'VIRTUAL' : 'FISICO',
        }
      : null;

    // 2. Cuotas con estado real
    const periodoActual = hoy.toISOString().slice(0, 7);
    let primeraPendienteMarcada = false;
    const cuotasInfo = (compra.cuotas ?? []).map((q) => {
      const est = (q.estado ?? '').toLowerCase();
      const iso = q.fecha_pago ? q.fecha_pago.toISOString().slice(0, 10) : null;
      const per = q.periodo_facturacion ?? (iso ? iso.slice(0, 7) : null);
      let estadoReal: EstadoRealCuota = 'FUTURA';
      if (est.startsWith('pagad')) {
        estadoReal = 'PAGADA';
      } else if (est.startsWith('refinanci') || est.startsWith('ajuste') || est.startsWith('absorbid')) {
        estadoReal = 'ABSORBIDA_REFINANCIAMIENTO';
      } else if (!primeraPendienteMarcada && (per === periodoActual || (q.fecha_pago && q.fecha_pago.getTime() <= hoy.getTime() + 31 * 86_400_000))) {
        estadoReal = 'EN_EXTRACTO_ACTUAL';
        primeraPendienteMarcada = true;
      } else if (!primeraPendienteMarcada) {
        estadoReal = 'EN_EXTRACTO_ACTUAL';
        primeraPendienteMarcada = true;
      }
      return {
        id: idNum(q.id),
        numeroCuota: Number(q.numero_cuota ?? 1),
        fechaPago: dateToMillis(q.fecha_pago),
        fechaPagoIso: iso,
        saldoRestante: num(q.saldo_restante),
        interesPagado: num(q.interes_pagado),
        aporteCapital: num(q.aporte_capital),
        pagoTotal: num(q.pago_total),
        estado: q.estado,
        estadoReal,
        periodoFacturacion: q.periodo_facturacion,
      };
    });

    // 3. Responsables con estado de cobro en liquidación mensual
    const responsablesInfo = (compra.responsables ?? []).map((r) => {
      const p = r.persona_ref;
      const esPropia = p?.linked_user_id !== null && p?.linked_user_id !== undefined && p.linked_user_id === ownerUserId;
      const movs = r.movimientos ?? [];
      const pagados = movs.filter((m) => (m.estado ?? '').toUpperCase() === 'PAGADO' || (m.estado ?? '').toUpperCase() === 'CONCILIADO');
      const montoCobrado = sumDecimals(pagados.map((m) => m.monto)).toNumber();
      let estadoCobroLiquidacion: 'COBRADO' | 'EN_LIQUIDACION' | 'PENDIENTE' | 'PROPIO' = 'PENDIENTE';
      if (esPropia) {
        estadoCobroLiquidacion = 'PROPIO';
      } else if (movs.length > 0 && pagados.length === movs.length) {
        estadoCobroLiquidacion = 'COBRADO';
      } else if (movs.length > 0) {
        estadoCobroLiquidacion = 'EN_LIQUIDACION';
      }
      return {
        id: idNum(r.id),
        personaId: r.persona === null ? null : idNum(r.persona),
        nombre: p?.nombre?.trim() || (r.persona ? `Persona #${r.persona}` : 'Sin asignar'),
        iniciales: p?.iniciales_nombre ?? null,
        color: p?.color_representativo ?? null,
        esPropia,
        porcentajePago: num(r.porcentaje_pago),
        cantidadPago: num(r.cantidad_pago),
        cantidadCuotas: r.cantidad_cuotas ?? (compra.numero_cuotas ?? 1),
        estadoCobroLiquidacion,
        montoCobrado,
      };
    });

    // 4. Notificación de correo bancario original
    const notif = compra.notificaciones?.[0] ?? null;
    const notificacionCorreo = notif
      ? {
          id: idNum(notif.id),
          externalMessageId: notif.external_message_id,
          remitente: notif.remitente,
          asunto: notif.asunto,
          fechaCorreo: notif.fecha_correo.toISOString(),
          cuerpoExtraido: notif.cuerpo_extraido,
          datosParseados: notif.datos_parseados,
          estadoProcesamiento: notif.estado_procesamiento,
          ultimos4: notif.ultimos_4,
          comercioNormalizado: notif.comercio_normalizado,
          montoOriginal: numOrNull(notif.monto_original),
          moneda: notif.moneda,
          vinculo: notif.vinculo,
        }
      : null;

    // 5. Refinanciamiento
    let refinanciamientoInfo: DetalleCompletoCompraCredito['refinanciamiento'] = null;
    if (compra.es_refinanciamiento) {
      refinanciamientoInfo = {
        id: idNum(compra.id),
        concepto: compra.concepto,
        esMaestra: true,
        maestraId: idNum(compra.id),
        fechaCompra: compra.fecha_compra ? compra.fecha_compra.toISOString().slice(0, 10) : null,
        saldoUnificado: num(compra.valor_compra),
        numeroCuotas: compra.numero_cuotas ?? 1,
        tasaMensual: num(compra.interes),
        cuotaMensual: num(compra.pago_mensual),
        sistemaAmortizacion: compra.sistema_amortizacion ?? 'FRANCES',
        absorbidasCount: compra.absorbidas?.length ?? 0,
      };
    } else if (compra.refinanciamiento) {
      const m = compra.refinanciamiento;
      refinanciamientoInfo = {
        id: idNum(m.id),
        concepto: m.concepto,
        esMaestra: false,
        maestraId: idNum(m.id),
        fechaCompra: m.fecha_compra ? m.fecha_compra.toISOString().slice(0, 10) : null,
        saldoUnificado: num(m.valor_compra),
        numeroCuotas: m.numero_cuotas ?? 1,
        tasaMensual: num(m.interes),
        cuotaMensual: num(m.pago_mensual),
        sistemaAmortizacion: m.sistema_amortizacion ?? 'FRANCES',
        absorbidasCount: m._count?.absorbidas ?? 0,
      };
    }

    // 6. Recurrencia
    const perRec = compra.periodos_pagados?.[0] ?? null;
    const recurrencia = perRec?.plantilla
      ? {
          id: idNum(perRec.id),
          plantillaId: idNum(perRec.plantilla.id),
          nombre: perRec.plantilla.nombre,
          frecuencia: perRec.plantilla.frecuencia,
          montoBaseEstimado: num(perRec.plantilla.monto_base_estimado),
          ultimoPeriodo: perRec.periodo,
          activa: perRec.plantilla.is_active !== false,
        }
      : null;

    // 7. Estadísticas de comercio en el año y porcentaje sobre gasto del mes en la tarjeta
    const inferido = inferirComercioYTags(`${compra.concepto ?? ''} ${compra.descripcion ?? ''}`);
    const comercioClave = compra.comercio_canonico || inferido.comercioCanonico || (compra.concepto?.trim() ?? 'Comercio');
    const fechaRef = compra.fecha_compra ?? hoy;
    const anio = fechaRef.getUTCFullYear();
    const inicioAnio = new Date(Date.UTC(anio, 0, 1));
    const finAnio = new Date(Date.UTC(anio, 11, 31, 23, 59, 59));

    const inicioMes = new Date(Date.UTC(fechaRef.getUTCFullYear(), fechaRef.getUTCMonth(), 1));
    const finMes = new Date(Date.UTC(fechaRef.getUTCFullYear(), fechaRef.getUTCMonth() + 1, 0, 23, 59, 59));

    const [comprasAnio, comprasMesTarjeta] = await Promise.all([
      this.prisma.comprasCredito.findMany({
        where: {
          owner_user_id: ownerUserId,
          fecha_compra: { gte: inicioAnio, lte: finAnio },
          es_refinanciamiento: false,
        },
        select: { id: true, concepto: true, descripcion: true, comercio_canonico: true, valor_compra: true },
      }),
      compra.tarjeta
        ? this.prisma.comprasCredito.findMany({
            where: {
              owner_user_id: ownerUserId,
              tarjeta: compra.tarjeta,
              fecha_compra: { gte: inicioMes, lte: finMes },
              es_refinanciamiento: false,
            },
            select: { valor_compra: true },
          })
        : Promise.resolve([]),
    ]);

    const claveNorm = normalizarComercio(comercioClave);
    const delMismoComercio = (comprasAnio ?? []).filter((c) => {
      if (c.comercio_canonico && c.comercio_canonico.toLowerCase() === comercioClave.toLowerCase()) return true;
      const normC = normalizarComercio(c.comercio_canonico || c.concepto || c.descripcion || '');
      return claveNorm.length > 0 && normC === claveNorm;
    });

    const totalHistoricoAnio = money(sumDecimals(delMismoComercio.map((c) => c.valor_compra))).toNumber();
    const cantidadComprasAnio = Math.max(1, delMismoComercio.length);

    const gastoMesDecimal = sumDecimals((comprasMesTarjeta ?? []).map((c) => c.valor_compra));
    const valorCompraDec = toDecimal(compra.valor_compra);
    const gastoMesFinal = gastoMesDecimal.greaterThan(0) ? gastoMesDecimal : valorCompraDec;
    const porcentajeMes = gastoMesFinal.greaterThan(0)
      ? Number(valorCompraDec.div(gastoMesFinal).mul(100).toDecimalPlaces(1).toString())
      : 100;

    const fechaCompraIso = compra.fecha_compra ? compra.fecha_compra.toISOString().slice(0, 10) : null;
    const fechaEstimadaPagoExtracto =
      cuotasInfo[0]?.fechaPagoIso ??
      (compra.fecha_ultima_cuota ? compra.fecha_ultima_cuota.toISOString().slice(0, 10) : fechaCompraIso);
    const totalInteresesReal = money(sumDecimals((compra.cuotas ?? []).map((q) => q.interes_pagado))).toNumber();

    return {
      compra: compraJson,
      tarjeta: tarjetaInfo,
      plastico: plasticoInfo,
      cuotas: cuotasInfo,
      responsables: responsablesInfo,
      notificacionCorreo,
      refinanciamiento: refinanciamientoInfo,
      recurrencia,
      estadisticasComercio: {
        comercioCanonico: comercioClave,
        totalHistoricoAnio,
        cantidadComprasAnio,
        gastoMesTarjeta: money(gastoMesFinal).toNumber(),
        porcentajeSobreGastoMesTarjeta: porcentajeMes,
      },
      resumenPagoUnico: {
        esUnaCuota: (compra.numero_cuotas ?? 1) === 1,
        fechaTransaccion: fechaCompraIso,
        fechaEstimadaPagoExtracto,
        costoFinanciero: (compra.numero_cuotas ?? 1) === 1 ? 0 : totalInteresesReal,
        gastoMesTarjeta: money(gastoMesFinal).toNumber(),
        porcentajeSobreGastoMesTarjeta: porcentajeMes,
      },
    };
  }

  // ───────────────────────────── PATCH parcial ─────────────────────────────

  /**
   * `PATCH /api/compras-credito/:id`: cambia SOLO lo enviado (edición en línea del detalle). Texto, estado, plástico, tags y comercio
   * canónico son una actualización simple; valor, cuotas, interés, fecha o tarjeta recalculan las cuotas (Regla 4) y no se permiten en una compra
   * ya unificada en un refinanciamiento.
   */
  async patchCompra(compraId: number, dto: PatchCompraCreditoInput, ownerUserId: bigint): Promise<CompraCreditoJson> {
    const enviados = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (enviados.length === 0) throw datosInvalidos({ compra: ['No hay nada que cambiar'] });

    await this.prisma.$transaction(async (tx) => {
      const existente = await this.requireCompra(tx, compraId, ownerUserId);
      if (dto.estado !== undefined && dto.estado.trim().toUpperCase() === 'REFINANCIADA') {
        throw datosInvalidos({ estado: ['«Refinanciada» solo la asigna el asistente de unificación de deuda'] });
      }
      const financiero =
        dto.valorCompra !== undefined ||
        dto.numeroCuotas !== undefined ||
        dto.interes !== undefined ||
        dto.fechaCompra !== undefined ||
        dto.tarjeta !== undefined;
      if (financiero) {
        const fecha = existente.fecha_compra ? existente.fecha_compra.toISOString().slice(0, 10) : undefined;
        await this.updateCompraTx(
          tx,
          compraId,
          {
            concepto: dto.concepto ?? existente.concepto ?? '',
            valorCompra: dto.valorCompra ?? existente.valor_compra?.toString(),
            fechaCompra: dto.fechaCompra ?? (fecha as string),
            numeroCuotas: dto.numeroCuotas ?? existente.numero_cuotas ?? 1,
            interes: dto.interes ?? existente.interes?.toString() ?? 0,
            descripcion: dto.descripcion ?? existente.descripcion ?? '',
            estado: dto.estado ?? existente.estado ?? 'Pendiente',
            tarjeta: dto.tarjeta ?? (existente.tarjeta as bigint),
            plasticoId: dto.plasticoId,
            tags: dto.tags,
            comercioCanonico: dto.comercioCanonico,
          },
          ownerUserId,
        );
        return;
      }
      const data: Prisma.ComprasCreditoUncheckedUpdateInput = {};
      if (dto.concepto !== undefined) data.concepto = dto.concepto;
      if (dto.descripcion !== undefined) data.descripcion = dto.descripcion;
      if (dto.estado !== undefined) data.estado = dto.estado;
      if (dto.tags !== undefined) {
        const tagsNorm = normalizarTags(dto.tags);
        data.tags = tagsNorm;
        await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsNorm);
      }
      if (dto.comercioCanonico !== undefined) {
        data.comercio_canonico = dto.comercioCanonico ? dto.comercioCanonico.trim() : null;
      }
      if (dto.plasticoId !== undefined) {
        if (existente.tarjeta === null) throw datosInvalidos({ plasticoId: ['La compra no tiene tarjeta'] });
        data.plastico_id = await resolverPlasticoCompra(tx, ownerUserId, existente.tarjeta, { plasticoId: dto.plasticoId, fecha: existente.fecha_compra });
      }
      await tx.comprasCredito.update({ where: { id: existente.id }, data });
    }, TX_OPTIONS);

    const actualizada = await this.getById(compraId, ownerUserId);
    if (!actualizada) throw new Error(`No se encontró la compra con ID ${compraId}`);
    return actualizada;
  }

  // ───────────────────────────── save ─────────────────────────────

  /**
   * Crea la compra y su tabla de amortización en una sola transacción.
   * Los responsables se asignan DESPUÉS (endpoint propio) para que el Trigger 6 encuentre las cuotas.
   */
  async save(input: CompraCreditoInput, ownerUserId: bigint): Promise<number> {
    return this.prisma.$transaction((tx) => this.saveTx(tx, input, ownerUserId), TX_OPTIONS);
  }

  /**
   * Versión transaccional de `save`, reutilizable desde otros servicios (sincronización de correos, conciliación)
   * para que la compra, sus cuotas y lo demás se confirmen o se reviertan juntos.
   */
  async saveTx(tx: Tx, input: CompraCreditoInput, ownerUserId: bigint): Promise<number> {
    const valores = this.resolverValores(input);
    this.validarCuotas(input.numeroCuotas);

    const tarjeta = await tx.tarjetas.findFirst({
      where: { id: BigInt(input.tarjeta), owner_user_id: ownerUserId },
      select: { id: true, dia_corte: true, tipo_tarjeta: true },
    });
    if (!tarjeta) throw new Error(`No se encontró la tarjeta con ID ${input.tarjeta}`);
    if (tarjeta.tipo_tarjeta === 'DEBITO') throw datosInvalidos({ tarjeta: ['Las compras a crédito solo se registran en tarjetas de crédito'] });

    const amortizacion = calcularAmortizacion(
      valores.valorCompra,
      valores.interes,
      input.numeroCuotas,
      valores.fechaCompra,
      false,
      tarjeta.dia_corte,
    );
    const fechaUltimaCuota = amortizacion[amortizacion.length - 1].fechaPago;
    const plasticoId = await resolverPlasticoCompra(tx, ownerUserId, tarjeta.id, {
      plasticoId: input.plasticoId,
      ultimos4: input.plasticoUltimos4,
      fecha: valores.fechaCompra,
    });

    const inferido = inferirComercioYTags(`${input.concepto ?? ''} ${input.descripcion ?? ''}`);
    const tagsResueltos = input.tags !== undefined ? normalizarTags(input.tags) : normalizarTags(inferido.tags);
    const comercioResuelto =
      input.comercioCanonico !== undefined ? (input.comercioCanonico?.trim() || null) : inferido.comercioCanonico;

    if (tagsResueltos.length > 0) {
      await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsResueltos);
    }

    const compra = await tx.comprasCredito.create({
      data: {
        plastico_id: plasticoId,
        concepto: input.concepto,
        valor_compra: toDbMoney(valores.valorCompra),
        fecha_compra: valores.fechaCompra,
        numero_cuotas: input.numeroCuotas,
        fecha_ultima_cuota: fechaUltimaCuota,
        pago_mensual: toDb(calcularPagoMensualTotal(valores.valorCompra, valores.interes, input.numeroCuotas)),
        interes: toDbRate(valores.interes),
        descripcion: input.descripcion,
        estado: input.estado,
        tarjeta: tarjeta.id,
        owner_user_id: ownerUserId,
        moneda_original: valores.moneda,
        valor_moneda_original: toDbMoney(valores.valorOriginal),
        tasa_cambio_aplicada: toDbRate(valores.tasa),
        trm_confirmada: valores.trmConfirmada,
        ...(input.tags !== undefined || tagsResueltos.length > 0 ? { tags: tagsResueltos } : {}),
        ...(input.comercioCanonico !== undefined || comercioResuelto !== null ? { comercio_canonico: comercioResuelto } : {}),
      },
    });

    await tx.cuotasDetalle.createMany({ data: this.cuotasData(compra.id, amortizacion) });
    return idNum(compra.id);
  }

  /**
   * Cambia el número de cuotas de una compra ya creada y recalcula la amortización respetando la Regla 4
   * (borra asientos del sub-ledger, recrea cuotas y re-dispara el Trigger 6).
   */
  async cambiarNumeroCuotasTx(tx: Tx, compraId: bigint | number, numeroCuotas: number, ownerUserId: bigint): Promise<ComprasCredito> {
    this.validarCuotas(numeroCuotas);
    const compra = await this.requireCompra(tx, Number(compraId), ownerUserId);
    this.exigirNoUnificada(compra, 'cambiar sus cuotas');
    const actualizada = await tx.comprasCredito.update({ where: { id: compra.id }, data: { numero_cuotas: numeroCuotas } });
    await this.recalcularTx(tx, actualizada);
    return tx.comprasCredito.findUniqueOrThrow({ where: { id: compra.id } });
  }

  // ───────────────────────────── update / recalcular ─────────────────────────────

  /**
   * `PUT /api/compras-credito`: actualiza la cabecera y recalcula las cuotas (Regla 4).
   * Devuelve las filas afectadas (1), igual que `compraCreditoRepositorio.update`.
   */
  async updateCompra(compraId: number, input: CompraCreditoInput, ownerUserId: bigint): Promise<number> {
    this.validarCuotas(input.numeroCuotas);

    return this.prisma.$transaction((tx) => this.updateCompraTx(tx, compraId, input, ownerUserId), TX_OPTIONS);
  }

  /** Versión transaccional de `updateCompra` (la reutiliza el PATCH parcial). */
  async updateCompraTx(tx: Tx, compraId: number, input: CompraCreditoInput, ownerUserId: bigint): Promise<number> {
    this.validarCuotas(input.numeroCuotas);
    const existente = await this.requireCompra(tx, compraId, ownerUserId);
    this.exigirNoUnificada(existente, 'modificarla');
    const valores = this.resolverValores(input, existente);

    const tarjeta = await tx.tarjetas.findFirst({
      where: { id: BigInt(input.tarjeta), owner_user_id: ownerUserId },
      select: { id: true, tipo_tarjeta: true },
    });
    if (!tarjeta) throw new Error(`No se encontró la tarjeta con ID ${input.tarjeta}`);
    if (tarjeta.tipo_tarjeta === 'DEBITO') throw datosInvalidos({ tarjeta: ['Las compras a crédito solo se registran en tarjetas de crédito'] });

    // El plástico solo cambia si el usuario lo eligió o si la compra se pasó a otra tarjeta; si no, se conserva (puede ser NULL).
    const cambiaPlastico = (input.plasticoId !== undefined && input.plasticoId !== null) || existente.tarjeta !== tarjeta.id;
    const plasticoId = cambiaPlastico
      ? await resolverPlasticoCompra(tx, ownerUserId, tarjeta.id, { plasticoId: input.plasticoId, fecha: valores.fechaCompra })
      : existente.plastico_id;

    let tagsActualizar: string[] | undefined;
    if (input.tags !== undefined) {
      tagsActualizar = normalizarTags(input.tags);
      await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsActualizar);
    }

    const actualizada = await tx.comprasCredito.update({
      where: { id: existente.id },
      data: {
        plastico_id: plasticoId,
        concepto: input.concepto,
        valor_compra: toDbMoney(valores.valorCompra),
        fecha_compra: valores.fechaCompra,
        numero_cuotas: input.numeroCuotas,
        interes: toDbRate(valores.interes),
        descripcion: input.descripcion,
        estado: input.estado,
        tarjeta: tarjeta.id,
        moneda_original: valores.moneda,
        valor_moneda_original: toDbMoney(valores.valorOriginal),
        tasa_cambio_aplicada: toDbRate(valores.tasa),
        trm_confirmada: valores.trmConfirmada,
        ...(tagsActualizar !== undefined ? { tags: tagsActualizar } : {}),
        ...(input.comercioCanonico !== undefined ? { comercio_canonico: input.comercioCanonico?.trim() || null } : {}),
      },
    });
    return this.recalcularTx(tx, actualizada);
  }

  /**
   * `recalcularCuotas(compraId, ownerUserId)`: relee la compra, recalcula la tabla de amortización y sincroniza
   * `CuotasDetalle` respetando la Regla 4. Si el concepto contiene "Ajuste de Interes" cobra interés en la cuota 1.
   */
  async recalcularCuotas(compraId: number, ownerUserId: bigint): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const compra = await this.requireCompra(tx, compraId, ownerUserId);
      this.exigirNoUnificada(compra, 'recalcular sus cuotas');
      return this.recalcularTx(tx, compra);
    }, TX_OPTIONS);
  }

  private async recalcularTx(tx: Tx, compra: ComprasCredito): Promise<number> {
    const cobraInteresPrimeraCuota = (compra.concepto ?? '').toUpperCase().includes(MARCA_AJUSTE_INTERES);
    const tarjeta = compra.tarjeta
      ? await tx.tarjetas.findUnique({ where: { id: compra.tarjeta }, select: { dia_corte: true } })
      : null;

    const valorCompra = toDecimal(compra.valor_compra);
    const interes = toDecimal(compra.interes);
    const numeroCuotas = compra.numero_cuotas ?? 0;
    this.validarCuotas(numeroCuotas);
    if (!compra.fecha_compra) throw new Error('La compra no tiene fecha de compra');

    // Un refinanciamiento se amortiza como el banco (cuota fija, interés desde la primera cuota); las demás, con capital fijo.
    const esFrances = compra.sistema_amortizacion === 'FRANCES';
    const amortizacion = esFrances
      ? calcularAmortizacionFrancesa(valorCompra, interes, numeroCuotas, compra.fecha_compra, tarjeta?.dia_corte, undefined, compra.cuota_fija_pactada ? toDecimal(compra.cuota_fija_pactada) : null)
      : calcularAmortizacion(valorCompra, interes, numeroCuotas, compra.fecha_compra, cobraInteresPrimeraCuota, tarjeta?.dia_corte);

    await this.reemplazarCuotas(tx, compra.id, amortizacion);

    const resultado = await tx.comprasCredito.updateMany({
      where: { id: compra.id },
      data: {
        fecha_ultima_cuota: amortizacion[amortizacion.length - 1].fechaPago,
        pago_mensual: toDb(esFrances ? amortizacion[0].pagoTotal : calcularPagoMensualTotal(valorCompra, interes, numeroCuotas)),
      },
    });
    return resultado.count;
  }

  /**
   * Regla 4 — sincroniza `CuotasDetalle` sin romper el sub-ledger `MovimientosDeudaPersona`:
   *  • Mismo número de cuotas → UPDATE por (compra, numero_cuota). El Trigger 8
   *    (`trg_sync_update_cuota_subledger`) actualiza monto/estado de los asientos existentes.
   *  • Distinto número de cuotas → borra los asientos que apuntan a las cuotas viejas, borra y recrea las cuotas y
   *    "toca" `ResponsablesComprasCredito` para que el Trigger 6 (`trg_after_insert_responsable_tc`) regenere los cargos.
   */
  async reemplazarCuotas(tx: Tx, compraId: bigint, nuevas: CuotaCalculada[]): Promise<void> {
    const existentes = await tx.cuotasDetalle.findMany({
      where: { compra: compraId },
      select: { id: true, numero_cuota: true },
    });
    const numerosExistentes = new Set(existentes.map((c) => Number(c.numero_cuota)));
    const mismoNumeroDeCuotas =
      existentes.length === nuevas.length && nuevas.every((c) => numerosExistentes.has(c.numeroCuota));

    if (mismoNumeroDeCuotas) {
      for (const cuota of nuevas) {
        await tx.cuotasDetalle.updateMany({
          where: { compra: compraId, numero_cuota: BigInt(cuota.numeroCuota) },
          data: {
            fecha_pago: cuota.fechaPago,
            saldo_restante: toDb(cuota.saldoRestante),
            interes_pagado: toDb(cuota.interesPagado),
            aporte_capital: toDb(cuota.aporteCapital),
            pago_total: toDb(cuota.pagoTotal),
            estado: cuota.estado,
            periodo_facturacion: cuota.periodoFacturacion,
          },
        });
      }
      // Los triggers 6/8 no actualizan fecha/periodo de los asientos ya creados: solo alineamos esos dos campos.
      await tx.$executeRaw`
        UPDATE "MovimientosDeudaPersona" m
        SET fecha_movimiento = cd.fecha_pago,
            periodo_imputacion = COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM'))
        FROM "CuotasDetalle" cd
        WHERE m.cuota_detalle_id = cd.id
          AND cd.compra = ${compraId}::int8
          AND cd.fecha_pago IS NOT NULL`;
      return;
    }

    const idsViejos = existentes.map((c) => c.id);
    if (idsViejos.length > 0) {
      await tx.movimientosDeudaPersona.deleteMany({ where: { cuota_detalle_id: { in: idsViejos } } });
    }
    await tx.cuotasDetalle.deleteMany({ where: { compra: compraId } });
    await tx.cuotasDetalle.createMany({ data: this.cuotasData(compraId, nuevas) });
    // UPDATE no-op sobre los responsables: dispara el Trigger 6 y regenera los cargos con las cuotas nuevas.
    await tx.$executeRaw`
      UPDATE "ResponsablesComprasCredito"
      SET porcentaje_pago = porcentaje_pago
      WHERE compra_credito = ${compraId}::int8`;
  }

  // ───────────────────────────── estados ─────────────────────────────

  /** `cambioEstado`: compras Pendiente/Activa cuya última cuota ya venció (< hoy) pasan a 'Pagado'. */
  async cambioEstado(ownerUserId: bigint, hoy: Date = todayLocal()): Promise<number> {
    const resultado = await this.prisma.comprasCredito.updateMany({
      where: {
        owner_user_id: ownerUserId,
        OR: [
          { estado: { equals: 'PENDIENTE', mode: 'insensitive' } },
          { estado: { equals: 'ACTIVA', mode: 'insensitive' } },
        ],
        fecha_ultima_cuota: { lt: hoy },
      },
      data: { estado: 'Pagado' },
    });
    return resultado.count;
  }

  /**
   * `POST /api/compras-credito/ajustar-interes-compras/:id`: las compras pendientes de la tarjeta pasan a
   * 'Ajuste Interes', se recalcula cobrando interés en la cuota 1 y las cuotas con fecha >= hoy quedan en
   * 'Ajuste Interes'. Todo en una transacción y siguiendo la Regla 4.
   */
  async ajusteInteresTarjetaCredito(tarjetaId: number, ownerUserId: bigint, hoy: Date = todayLocal()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const tarjeta = await tx.tarjetas.findFirst({
        where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId },
        select: { dia_corte: true },
      });
      const compras = await tx.comprasCredito.findMany({
        where: {
          tarjeta: BigInt(tarjetaId),
          owner_user_id: ownerUserId,
          estado: { equals: 'PENDIENTE', mode: 'insensitive' },
        },
      });

      for (const compra of compras) {
        await tx.comprasCredito.update({ where: { id: compra.id }, data: { estado: ESTADO_AJUSTE_INTERES } });
        if (!compra.fecha_compra || !compra.numero_cuotas) continue;

        const amortizacion = calcularAmortizacion(
          toDecimal(compra.valor_compra),
          toDecimal(compra.interes),
          compra.numero_cuotas,
          compra.fecha_compra,
          true,
          tarjeta?.dia_corte,
          hoy,
        ).map((cuota) => ({
          ...cuota,
          estado: cuota.fechaPago.getTime() >= hoy.getTime() ? ESTADO_AJUSTE_INTERES : cuota.estado,
        }));

        await this.reemplazarCuotas(tx, compra.id, amortizacion);
      }
    }, TX_OPTIONS);
  }

  // ───────────────────────────── delete ─────────────────────────────

  /**
   * Eliminación en cascada dentro de una transacción (DOCUMENTACION_DELETE_UPDATE.md + sub-ledger):
   * MovimientosDeudaPersona → ResponsablesComprasCredito → CuotasDetalle → ComprasCredito.
   */
  async delete(compraId: number, ownerUserId: bigint): Promise<void> {
    await this.prisma.$transaction((tx) => this.deleteTx(tx, compraId, ownerUserId), TX_OPTIONS);
  }

  /** Versión transaccional del borrado en cascada (la usa también el descarte de compras importadas por correo). */
  async deleteTx(tx: Tx, compraId: number, ownerUserId: bigint, opciones: { desdeDeshacer?: boolean } = {}): Promise<void> {
    const compra = await this.requireCompra(tx, compraId, ownerUserId);
    if (!opciones.desdeDeshacer) {
      this.exigirNoUnificada(compra, 'eliminarla');
      const absorbidas = await tx.comprasCredito.count({ where: { refinanciamiento_id: compra.id } });
      if (absorbidas > 0) {
        throw new HttpException(
          { message: `Esta compra es un refinanciamiento que unifica ${absorbidas} compra${absorbidas === 1 ? '' : 's'}: deshazlo primero para eliminarla` },
          HttpStatus.CONFLICT,
        );
      }
    }

    const cuotas = await tx.cuotasDetalle.findMany({ where: { compra: compra.id }, select: { id: true } });
    const responsables = await tx.responsablesComprasCredito.findMany({
      where: { compra_credito: compra.id },
      select: { id: true },
    });
    const cuotaIds = cuotas.map((c) => c.id);
    const responsableIds = responsables.map((r) => r.id);

    if (cuotaIds.length > 0 || responsableIds.length > 0) {
      await tx.movimientosDeudaPersona.deleteMany({
        where: {
          OR: [
            ...(cuotaIds.length > 0 ? [{ cuota_detalle_id: { in: cuotaIds } }] : []),
            ...(responsableIds.length > 0 ? [{ responsable_compra_id: { in: responsableIds } }] : []),
          ],
        },
      });
    }
    await tx.responsablesComprasCredito.deleteMany({ where: { compra_credito: compra.id } });
    await tx.cuotasDetalle.deleteMany({ where: { compra: compra.id } });
    // Referencias opcionales desde otros dominios: se desvinculan para no violar llaves foráneas.
    await tx.notificacionesCorreo.updateMany({
      where: { compra_credito_generada_id: compra.id },
      data: { compra_credito_generada_id: null },
    });
    await tx.periodosRecurrentes.updateMany({
      where: { compra_credito_pago_id: compra.id },
      data: { compra_credito_pago_id: null },
    });
    await tx.comprasCredito.delete({ where: { id: compra.id } });
  }

  // ───────────────────────────── multimoneda ─────────────────────────────

  /**
   * `PATCH /api/v2/compras-credito/:id/confirmar-trm` → `sp_actualizar_trm_compra_usd`.
   * El SP recalcula cuotas pendientes; el Trigger 8 actualiza el sub-ledger. No se duplica esa lógica aquí.
   */
  async confirmarTrm(
    compraId: number,
    ownerUserId: bigint,
    nuevaTrm: number | string,
    confirmarDefinitivo = true,
  ): Promise<CompraCreditoJson> {
    const trm = rate(toDecimal(nuevaTrm));
    if (!trm.greaterThan(0)) throw datosInvalidos({ nuevaTrm: ['nuevaTrm debe ser mayor a 0'] });

    await this.prisma.$transaction(async (tx) => {
      const compra = await this.requireCompra(tx, compraId, ownerUserId);
      if (compra.moneda_original === 'COP') {
        throw new HttpException(
          { message: 'La compra está en COP: no requiere confirmación de TRM' },
          HttpStatus.BAD_REQUEST,
        );
      }
      await tx.$executeRaw`
        SELECT sp_actualizar_trm_compra_usd(${compra.id}::int8, ${toDb(trm)}::numeric(12,4), ${confirmarDefinitivo}::bool)`;
    }, TX_OPTIONS);

    const actualizada = await this.getById(compraId, ownerUserId);
    if (!actualizada) throw new Error(`No se encontró la compra con ID ${compraId}`);
    return actualizada;
  }

  // ───────────────────────────── Fase 2 (Iteración 3): Propagación a Compras Similares ─────────────────────────────

  /**
   * `POST /api/v2/compras-credito/:id/buscar-similares` — Detecta compras activas del mismo comercio
   * (diferenciando estrictamente DiDi Food de DiDi Rides, Rappi de Rappi Pro, etc.) que tengan al menos
   * un atributo distinto (`numeroCuotas`, `responsables`, `tags`, `comercioCanonico`) respecto a la compra origen.
   */
  async buscarComprasSimilaresParaPropagacion(compraId: number, ownerUserId: bigint) {
    const origen = await this.prisma.comprasCredito.findFirst({
      where: { id: BigInt(compraId), owner_user_id: ownerUserId },
      include: {
        responsables: {
          include: { persona_ref: true },
          orderBy: { id: 'asc' },
        },
        tarjeta_ref: true,
      },
    });
    if (!origen) {
      throw new HttpException({ message: `Compra ${compraId} no encontrada` }, HttpStatus.NOT_FOUND);
    }

    const comercioOrigen = resolverComercioCanonicoCompra(origen);
    const cuotasOrigen = origen.numero_cuotas ?? 1;
    const tagsOrigen = normalizarTags(origen.tags ?? []);
    const firmaRespOrigen = (origen.responsables ?? [])
      .filter((r) => r.persona !== null)
      .map((r) => `${r.persona}:${num(r.porcentaje_pago)}`)
      .sort()
      .join('|');

    const otrasCompras = await this.prisma.comprasCredito.findMany({
      where: {
        owner_user_id: ownerUserId,
        id: { not: origen.id },
        refinanciamiento_id: null,
        es_refinanciamiento: false,
      },
      include: {
        responsables: {
          include: { persona_ref: true },
          orderBy: { id: 'asc' },
        },
        tarjeta_ref: true,
      },
      orderBy: [{ fecha_compra: 'desc' }, { id: 'desc' }],
    });

    const candidatas = [];
    for (const c of otrasCompras) {
      if (!sonComerciosSimilaresEstrictos(origen, c)) continue;

      const cuotasActual = c.numero_cuotas ?? 1;
      const tagsActuales = normalizarTags(c.tags ?? []);
      const firmaRespActual = (c.responsables ?? [])
        .filter((r) => r.persona !== null)
        .map((r) => `${r.persona}:${num(r.porcentaje_pago)}`)
        .sort()
        .join('|');
      const comercioActual = c.comercio_canonico ?? null;

      const diferenciasDetectadas: string[] = [];
      if (cuotasActual !== cuotasOrigen) diferenciasDetectadas.push('CUOTAS');
      if (firmaRespActual !== firmaRespOrigen) diferenciasDetectadas.push('RESPONSABLES');
      if (tagsActuales.join(',') !== tagsOrigen.join(',')) diferenciasDetectadas.push('TAGS');
      if ((comercioActual ?? '') !== (origen.comercio_canonico ?? comercioOrigen)) {
        diferenciasDetectadas.push('COMERCIO_CANONICO');
      }

      if (diferenciasDetectadas.length === 0) continue;

      const tRef = c.tarjeta_ref;
      const tarjetaNombre = tRef
        ? [tRef.franquicia, tRef.descripcion].filter(Boolean).join(' · ') || `Tarjeta #${tRef.id}`
        : c.tarjeta
          ? `Tarjeta #${c.tarjeta}`
          : 'Sin tarjeta';

      candidatas.push({
        id: idNum(c.id),
        concepto: c.concepto ?? '',
        descripcion: c.descripcion ?? '',
        fechaCompra: c.fecha_compra ? c.fecha_compra.toISOString().slice(0, 10) : null,
        valorTotal: num(c.valor_compra),
        numeroCuotasActual: cuotasActual,
        responsablesActuales: (c.responsables ?? []).map((r) => ({
          personaId: r.persona === null ? null : idNum(r.persona),
          nombre: r.persona_ref?.nombre?.trim() || (r.persona ? `Persona #${r.persona}` : 'Sin asignar'),
          porcentajePago: num(r.porcentaje_pago),
        })),
        tagsActuales,
        comercioCanonicoActual: comercioActual,
        tarjetaNombre,
        diferenciasDetectadas,
      });
    }

    return {
      compraOrigen: {
        id: idNum(origen.id),
        concepto: origen.concepto ?? '',
        comercioCanonico: origen.comercio_canonico ?? comercioOrigen,
        numeroCuotas: cuotasOrigen,
        tags: tagsOrigen,
        responsables: (origen.responsables ?? []).map((r) => ({
          personaId: r.persona === null ? null : idNum(r.persona),
          nombre: r.persona_ref?.nombre?.trim() || (r.persona ? `Persona #${r.persona}` : 'Sin asignar'),
          porcentajePago: num(r.porcentaje_pago),
        })),
      },
      candidatas,
    };
  }

  /**
   * `PATCH /api/v2/compras-credito/propagar-edicion-similares` — Propaga selectivamente cuotas,
   * responsables porcentuales, tags y comercio canónico desde `compraOrigenId` hacia `compraDestinoIds`.
   */
  async propagarEdicionSimilares(dto: PropagarEdicionSimilaresDto, ownerUserId: bigint) {
    const destinoIdsUnicos = [...new Set((dto.compraDestinoIds ?? []).filter((id) => Number.isInteger(id) && id > 0 && id !== dto.compraOrigenId))];
    if (destinoIdsUnicos.length === 0) {
      return {
        actualizadas: 0,
        idsActualizados: [] as number[],
        cuotasRecalculadas: 0,
        responsablesReplicados: 0,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      const origen = await tx.comprasCredito.findFirst({
        where: { id: BigInt(dto.compraOrigenId), owner_user_id: ownerUserId },
        include: {
          responsables: { orderBy: { id: 'asc' } },
        },
      });
      if (!origen) {
        throw new HttpException({ message: `Compra origen ${dto.compraOrigenId} no encontrada` }, HttpStatus.NOT_FOUND);
      }

      const aplicarCuotas = dto.aplicarCuotas ?? false;
      const aplicarResponsables = dto.aplicarResponsables ?? false;
      const aplicarTags = dto.aplicarTags ?? false;
      const aplicarComercioCanonico = dto.aplicarComercioCanonico ?? false;
      const modoTags = dto.modoTags ?? 'MERGE';

      const tagsOrigen = normalizarTags(origen.tags ?? []);
      if (aplicarTags && tagsOrigen.length > 0) {
        await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsOrigen);
      }
      const comercioCanonicoOrigen = origen.comercio_canonico?.trim() || resolverComercioCanonicoCompra(origen) || null;

      const destinos = await tx.comprasCredito.findMany({
        where: {
          owner_user_id: ownerUserId,
          id: { in: destinoIdsUnicos.map((id) => BigInt(id)) },
          refinanciamiento_id: null,
          es_refinanciamiento: false,
        },
      });

      const idsActualizados: number[] = [];
      let cuotasRecalculadas = 0;
      let responsablesReplicados = 0;

      for (const destino of destinos) {
        const updateData: Prisma.ComprasCreditoUncheckedUpdateInput = {};
        const nuevoNumeroCuotas = aplicarCuotas && origen.numero_cuotas ? origen.numero_cuotas : (destino.numero_cuotas ?? 1);
        const cambioCuotas = aplicarCuotas && origen.numero_cuotas !== null && destino.numero_cuotas !== origen.numero_cuotas;

        if (cambioCuotas) {
          updateData.numero_cuotas = nuevoNumeroCuotas;
        }
        if (aplicarTags) {
          const actuales = normalizarTags(destino.tags ?? []);
          updateData.tags = modoTags === 'REEMPLAZAR' ? tagsOrigen : normalizarTags([...actuales, ...tagsOrigen]);
        }
        if (aplicarComercioCanonico && comercioCanonicoOrigen) {
          updateData.comercio_canonico = comercioCanonicoOrigen;
        }

        let destinoActualizado = destino;
        if (Object.keys(updateData).length > 0) {
          destinoActualizado = await tx.comprasCredito.update({
            where: { id: destino.id },
            data: updateData,
          });
        }

        if (cambioCuotas) {
          await this.recalcularTx(tx, destinoActualizado);
          cuotasRecalculadas++;
        }

        if (aplicarResponsables) {
          const respExistentes = await tx.responsablesComprasCredito.findMany({
            where: { compra_credito: destino.id },
            select: { id: true },
          });
          if (respExistentes.length > 0) {
            await tx.movimientosDeudaPersona.deleteMany({
              where: { responsable_compra_id: { in: respExistentes.map((r) => r.id) } },
            });
            await tx.responsablesComprasCredito.deleteMany({ where: { compra_credito: destino.id } });
          }

          const valorDestino = toDecimal(destinoActualizado.valor_compra);
          for (const rOrig of origen.responsables ?? []) {
            if (rOrig.persona === null) continue;
            const pct = toDecimal(rOrig.porcentaje_pago);
            const cantidadPago = money(valorDestino.mul(pct).div(100));
            await tx.responsablesComprasCredito.create({
              data: {
                persona: rOrig.persona,
                compra_credito: destino.id,
                porcentaje_pago: toDb(pct),
                cantidad_pago: toDbMoney(cantidadPago),
                cantidad_cuotas: nuevoNumeroCuotas,
              },
            });
          }
          responsablesReplicados++;
        }

        idsActualizados.push(idNum(destino.id));
      }

      return {
        actualizadas: idsActualizados.length,
        idsActualizados,
        cuotasRecalculadas,
        responsablesReplicados,
      };
    }, TX_OPTIONS);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async sincronizarCatalogoEtiquetasTx(tx: Tx, ownerUserId: bigint, slugs: string[]): Promise<void> {
    if (!tx.etiquetas || typeof tx.etiquetas.upsert !== 'function') return;
    for (const slug of slugs) {
      await tx.etiquetas.upsert({
        where: { owner_user_id_slug: { owner_user_id: ownerUserId, slug } },
        create: {
          owner_user_id: ownerUserId,
          slug,
          nombre: nombreLegibleTag(slug),
          color: colorSugeridoTag(slug),
          tipo_agrupacion: 'HABITO',
        },
        update: {},
      });
    }
  }

  async requireCompra(tx: Tx, compraId: number, ownerUserId: bigint): Promise<ComprasCredito> {
    const compra = await tx.comprasCredito.findFirst({ where: { id: BigInt(compraId), owner_user_id: ownerUserId } });
    if (!compra) throw new Error(`No se encontró la compra con ID ${compraId}`);
    return compra;
  }

  /** Una compra unificada en un refinanciamiento ya no se cobra por sí sola: cambiarle valor, cuotas o fecha rompería la trazabilidad. */
  private exigirNoUnificada(compra: ComprasCredito, accion: string): void {
    if (compra.refinanciamiento_id !== null && compra.refinanciamiento_id !== undefined) {
      throw new HttpException(
        { message: `Esta compra fue unificada en el refinanciamiento #${compra.refinanciamiento_id}: deshaz el refinanciamiento para ${accion}` },
        HttpStatus.CONFLICT,
      );
    }
  }

  private validarCuotas(numeroCuotas: number): void {
    if (!Number.isInteger(numeroCuotas) || numeroCuotas < 1) {
      throw datosInvalidos({ numeroCuotas: ['numeroCuotas debe ser un entero mayor o igual a 1'] });
    }
  }

  /**
   * Resuelve valores monetarios con Decimal (Regla 1) y el modelo multimoneda:
   *  • COP (default): valor_moneda_original = valor_compra, tasa 1.0000, trm_confirmada = true.
   *  • Otra divisa: valor_compra = valor_moneda_original × tasa (2 decimales); trm_confirmada = false salvo indicación.
   * Si se actualiza una compra en divisa extranjera sin enviar `monedaOriginal` (cliente legacy), se conserva su
   * divisa/TRM y el valor original se deriva del valor COP recibido.
   */
  resolverValores(input: CompraCreditoInput, existente?: ComprasCredito): ValoresCompra {
    // Igual que SimpleDateFormat.parse del legacy: solo cuenta el prefijo yyyy-MM-dd (acepta '2024-04-05T10:00:00Z').
    const fechaCompra = input.fechaCompra instanceof Date ? input.fechaCompra : parseIsoDate(input.fechaCompra.slice(0, 10));
    if (!fechaCompra) throw datosInvalidos({ fechaCompra: ['fechaCompra debe tener formato yyyy-MM-dd'] });

    const interes = rate(toDecimal(input.interes));
    if (interes.isNegative()) throw datosInvalidos({ interes: ['interes no puede ser negativo'] });

    const base =
      !input.monedaOriginal && existente && existente.moneda_original !== 'COP' && existente.tasa_cambio_aplicada
        ? existente
        : undefined;
    const moneda = (input.monedaOriginal ?? base?.moneda_original ?? 'COP').toUpperCase();

    if (moneda === 'COP') {
      if (input.valorCompra === undefined || input.valorCompra === null) {
        throw datosInvalidos({ valorCompra: ['valorCompra es obligatorio'] });
      }
      const valorCompra = money(toDecimal(input.valorCompra));
      this.validarPositivo(valorCompra, 'valorCompra');
      return {
        moneda,
        fechaCompra,
        valorCompra,
        valorOriginal: valorCompra,
        tasa: new Decimal('1.0000'),
        trmConfirmada: true,
        interes,
      };
    }

    if (base) {
      const tasa = rate(toDecimal(base.tasa_cambio_aplicada));
      const valorCompra = money(toDecimal(input.valorCompra));
      this.validarPositivo(valorCompra, 'valorCompra');
      return {
        moneda,
        fechaCompra,
        valorCompra,
        valorOriginal: money(valorCompra.div(tasa)),
        tasa,
        trmConfirmada: base.trm_confirmada ?? false,
        interes,
      };
    }

    if (
      input.valorMonedaOriginal === undefined ||
      input.valorMonedaOriginal === null ||
      input.tasaCambioAplicada === undefined ||
      input.tasaCambioAplicada === null
    ) {
      throw datosInvalidos({
        valorMonedaOriginal: ['valorMonedaOriginal y tasaCambioAplicada son obligatorios para monedas distintas de COP'],
      });
    }
    const valorOriginal = money(toDecimal(input.valorMonedaOriginal));
    const tasa = rate(toDecimal(input.tasaCambioAplicada));
    this.validarPositivo(valorOriginal, 'valorMonedaOriginal');
    this.validarPositivo(tasa, 'tasaCambioAplicada');
    return {
      moneda,
      fechaCompra,
      valorCompra: money(valorOriginal.mul(tasa)),
      valorOriginal,
      tasa,
      trmConfirmada: input.trmConfirmada ?? false,
      interes,
    };
  }

  private validarPositivo(value: Decimal, campo: string): void {
    if (!value.greaterThan(0)) throw datosInvalidos({ [campo]: [`${campo} debe ser mayor a 0`] });
  }

  cuotasData(compraId: bigint, cuotas: CuotaCalculada[]): Prisma.CuotasDetalleCreateManyInput[] {
    return cuotas.map((c) => ({
      numero_cuota: BigInt(c.numeroCuota),
      fecha_pago: c.fechaPago,
      saldo_restante: toDb(c.saldoRestante),
      interes_pagado: toDb(c.interesPagado),
      aporte_capital: toDb(c.aporteCapital),
      pago_total: toDb(c.pagoTotal),
      compra: compraId,
      estado: c.estado,
      periodo_facturacion: c.periodoFacturacion,
    }));
  }

  toJson(c: ComprasCredito, responsables: string, porcentajePago: number, plasticoUltimos4: string | null = null): CompraCreditoJson {
    return {
      id: idNum(c.id),
      fechaCreacion: timestampToDayMillis(c.created_at),
      concepto: c.concepto,
      valorCompra: num(c.valor_compra),
      fechaCompra: dateToMillis(c.fecha_compra),
      numeroCuotas: c.numero_cuotas ?? 0,
      fechaUltimaCuota: dateToMillis(c.fecha_ultima_cuota),
      pagoMensual: num(c.pago_mensual),
      interes: num(c.interes),
      descripcion: c.descripcion,
      estado: c.estado,
      tarjeta: idNum(c.tarjeta),
      responsables,
      porcentajePago,
      monedaOriginal: c.moneda_original,
      valorMonedaOriginal: numOrNull(c.valor_moneda_original),
      tasaCambioAplicada: numOrNull(c.tasa_cambio_aplicada),
      trmConfirmada: c.trm_confirmada,
      plasticoId: c.plastico_id === null || c.plastico_id === undefined ? null : idNum(c.plastico_id),
      plasticoUltimos4,
      refinanciamientoId: c.refinanciamiento_id === null || c.refinanciamiento_id === undefined ? null : idNum(c.refinanciamiento_id),
      esRefinanciamiento: c.es_refinanciamiento ?? false,
      saldoRefinanciado: numOrNull(c.saldo_refinanciado),
      sistemaAmortizacion: c.sistema_amortizacion ?? 'CAPITAL_FIJO',
      cuotaFijaPactada: numOrNull(c.cuota_fija_pactada),
      tags: c.tags ?? [],
      comercioCanonico: c.comercio_canonico ?? null,
    };
  }
}
