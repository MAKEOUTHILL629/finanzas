import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidPeriodo, parseIsoDate, periodoActual, todayLocal } from '../../common/utils/date.util';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { addMesesPeriodo } from '../../common/utils/periodo.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { EstadoCuentaPersonasService } from '../estado-cuenta-personas/estado-cuenta-personas.service';
import { ItemCuenta, ItemTarjeta, LookupService } from '../lookup/lookup.service';
import { SubledgerDeudasService } from '../subledger-deudas/subledger-deudas.service';
import { ExtractoPendiente, proximosVencimientos, VencimientoExtracto } from './dashboard.util';

/** Persona «yo» del AppSheet original (la misma que usan los triggers del sub-ledger). */
const LEGACY_YO = 'lm1R40P16oHgkM3Szu91du';
/** Periodo de facturación de la cuota (si falta, el mes de su fecha de pago). */
const PERIODO_CUOTA = Prisma.raw(`COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM'))`);
const NO_PAGADA = Prisma.raw(`UPPER(COALESCE(cd.estado, '')) NOT IN ('PAGADO', 'PAGADA')`);

const cero = () => new Decimal(0);
const suma = (xs: Decimal[]): Decimal => money(xs.reduce((a, x) => a.plus(x), cero()));

export type GranularidadAnalitica = 'DIA' | 'SEMANA' | 'MES';

export interface FiltroAnaliticaAvanzadaInput {
  fechaInicio?: string;
  fechaFin?: string;
  granularidad?: GranularidadAnalitica;
  cuentaIds?: string | string[] | number[];
  tarjetaIds?: string | string[] | number[];
  categoriaIds?: string | string[] | number[];
  personaIds?: string | string[] | number[];
  soloGastoPropio?: string | boolean;
  incluirTransferenciasInternas?: string | boolean;
}

function parseIdsFiltro(v: string | string[] | number[] | undefined): number[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',');
  return raw
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseBoolFiltro(v: string | boolean | undefined, defecto = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'si', 'sí'].includes(v.trim().toLowerCase());
  return defecto;
}

const COLORES_CATEGORIA_FALLBACK = ['#007AFF', '#34C759', '#5856D6', '#FF9500', '#FF2D55', '#32ADE6', '#AF52DE', '#FF3B30'];
const NOMBRES_DIA_SEMANA = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

interface FilaExtracto {
  tarjeta_id: bigint;
  periodo: string;
  total: Prisma.Decimal | null;
  terceros: Prisma.Decimal | null;
  /** Cuotas del periodo que siguen sin marcarse pagadas (cualquier periodo). */
  sin_pagar: Prisma.Decimal | null;
  /** Lo mismo, pero solo de este periodo en adelante: es lo que de verdad se debe. */
  pendiente: Prisma.Decimal | null;
  pendiente_terceros: Prisma.Decimal | null;
  capital_pendiente: Prisma.Decimal | null;
}

interface FilaMovimiento {
  id: bigint;
  fecha_transaccion: Date;
  concepto: string;
  tipo_transaccion: string;
  monto_cop: Prisma.Decimal;
  estado: string | null;
  cuenta_origen: string | null;
  cuenta_destino: string | null;
}

export interface TarjetaDashboard {
  id: number;
  nombre: string;
  etiqueta: string;
  cupoTotal: Decimal | null;
  /** Capital que falta por pagar de todas las compras de la tarjeta (lo que ocupa del cupo). */
  cupoUtilizado: Decimal;
  /** 0–100; `null` si la tarjeta no tiene cupo registrado. */
  porcentajeCupo: number | null;
  diaCorte: number | null;
  diaLimitePago: number | null;
  /** Extracto del periodo consultado: lo que cobra el banco y cómo se reparte. */
  pagoDelMes: Decimal;
  miParte: Decimal;
  terceros: Decimal;
  /** Todo lo que falta por pagar a la tarjeta (cuotas del periodo consultado en adelante), intereses incluidos. */
  deudaPendiente: Decimal;
  deudaPendienteMiParte: Decimal;
  /**
   * Cuotas de meses anteriores que nunca se marcaron como pagadas. No se suman a la deuda (casi siempre ya se pagaron en el banco y
   * falta registrarlo con «Pagar extracto»), pero se informan para que se puedan ponerse al día.
   */
  vencidoSinRegistrar: Decimal;
  proximoVencimiento: VencimientoExtracto | null;
  /** Tarjeta prestada (Fase 5): se lista aparte y no suma al cupo propio. */
  esTitularExterno: boolean;
  titularPersonaId: number | null;
}

/**
 * Resumen ejecutivo de la pantalla de inicio en UNA sola llamada: liquidez y patrimonio, flujo del mes, tarjetas (mi parte vs.
 * terceros), lo que te deben las personas, próximos vencimientos y movimientos recientes. Reutiliza los mismos servicios y consultas
 * de cada módulo, así las cifras coinciden exactamente con las pantallas de detalle.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: LookupService,
    private readonly subledger: SubledgerDeudasService,
    private readonly estadoCuentaPersonas: EstadoCuentaPersonasService,
  ) {}

  async resumen(ownerUserId: bigint, periodoPedido: string | undefined, ahora: Date = new Date()) {
    const periodo = periodoPedido ?? periodoActual();
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    const hoy = todayLocal(ahora);

    const [usuario, cuentas, tarjetas, extractos, flujo, personas, movimientos, alertas] = await Promise.all([
      this.prisma.users.findUnique({ where: { id: ownerUserId }, select: { name: true } }),
      this.lookup.cuentas(ownerUserId),
      // El resumen de tarjetas (cupo, vencimientos, extracto) es de las de crédito con número; el débito y el producto «sin número» no entran.
      Promise.resolve(this.lookup.tarjetas(ownerUserId)).then((lista) => lista.filter((t) => t.tipo !== 'DEBITO' && !t.esGenerica)),
      this.extractosPorTarjeta(ownerUserId, periodo),
      this.subledger.flujoCaja(periodo, ownerUserId),
      this.estadoCuentaPersonas.listar(ownerUserId, periodo),
      this.movimientosRecientes(ownerUserId),
      this.alertas(ownerUserId),
    ]);

    const liquidez = this.liquidez(cuentas);
    const tarjetasResumen = this.tarjetas(tarjetas, extractos, periodo, hoy);
    const porCobrar = this.porCobrar(personas);

    const deudaTarjetas = suma(tarjetasResumen.map((t) => t.deudaPendiente));
    const patrimonioNeto = money(liquidez.total.plus(porCobrar.deudaTotal).minus(deudaTarjetas));

    return {
      periodo,
      usuario: { nombre: usuario?.name ?? null },
      generadoEn: ahora.toISOString(),
      liquidez: { ...liquidez, patrimonioNeto: { valor: patrimonioNeto, liquidez: liquidez.total, porCobrar: porCobrar.deudaTotal, deudaTarjetas } },
      flujoMes: {
        ingresos: money(toDecimal(flujo.total_ingresos)),
        egresosDirectos: money(toDecimal(flujo.total_egresos_directos)),
        tarjetas: money(toDecimal(flujo.total_tarjetas)),
        recurrentes: money(toDecimal(flujo.total_esperado_recurrentes)),
        porCobrarTerceros: money(toDecimal(flujo.total_por_cobrar_terceros)),
        desembolsoBruto: money(toDecimal(flujo.desembolso_bruto_mes)),
        gastosPropios: money(toDecimal(flujo.gasto_neto_real_tuyo)),
        flujoLibre: money(toDecimal(flujo.flujo_caja_libre_estimado)),
        transferenciasInternas: money(toDecimal(flujo.total_transferencias_internas)),
      },
      tarjetas: {
        items: tarjetasResumen,
        totales: {
          pagoDelMes: suma(tarjetasResumen.map((t) => t.pagoDelMes)),
          miParte: suma(tarjetasResumen.map((t) => t.miParte)),
          terceros: suma(tarjetasResumen.map((t) => t.terceros)),
          deudaPendiente: deudaTarjetas,
          vencidoSinRegistrar: suma(tarjetasResumen.map((t) => t.vencidoSinRegistrar)),
          // Solo tarjetas propias: las prestadas (Fase 5) no ocupan cupo bancario del usuario.
          cupoTotal: suma(tarjetasResumen.filter((t) => !t.esTitularExterno).map((t) => t.cupoTotal ?? cero())),
          cupoUtilizado: suma(tarjetasResumen.filter((t) => !t.esTitularExterno).map((t) => t.cupoUtilizado)),
          tarjetasPrestadas: tarjetasResumen.filter((t) => t.esTitularExterno).length,
        },
      },
      porCobrar,
      proximosVencimientos: this.vencimientos(tarjetasResumen),
      movimientosRecientes: movimientos,
      alertas,
    };
  }

  // ───────────────────────────── Iteración 2 — Fase 6: Analítica Avanzada Multi-Filtro ─────────────────────────────

  async analiticaAvanzada(ownerUserId: bigint, query: FiltroAnaliticaAvanzadaInput = {}, ahora: Date = new Date()) {
    const granularidad: GranularidadAnalitica =
      query.granularidad === 'DIA' || query.granularidad === 'SEMANA' || query.granularidad === 'MES' ? query.granularidad : 'MES';
    const cuentaIds = parseIdsFiltro(query.cuentaIds);
    const tarjetaIds = parseIdsFiltro(query.tarjetaIds);
    const categoriaIds = parseIdsFiltro(query.categoriaIds);
    const personaIds = parseIdsFiltro(query.personaIds);
    const soloGastoPropio = parseBoolFiltro(query.soloGastoPropio, false);
    const incluirTransferenciasInternas = parseBoolFiltro(query.incluirTransferenciasInternas, false);

    const hoy = todayLocal(ahora);
    const fechaFin = (query.fechaFin ? parseIsoDate(query.fechaFin.slice(0, 10)) : null) ?? new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 0, 23, 59, 59));
    const fechaInicioDefault = new Date(Date.UTC(fechaFin.getUTCFullYear(), fechaFin.getUTCMonth() - 5, 1, 0, 0, 0));
    const fechaInicio = (query.fechaInicio ? parseIsoDate(query.fechaInicio.slice(0, 10)) : null) ?? fechaInicioDefault;

    const duracionMs = Math.max(86_400_000, fechaFin.getTime() - fechaInicio.getTime());
    const fechaInicioAnterior = new Date(fechaInicio.getTime() - duracionMs);
    const fechaFinAnterior = new Date(fechaInicio.getTime() - 1);

    const periodoRef = `${fechaFin.getUTCFullYear()}-${String(fechaFin.getUTCMonth() + 1).padStart(2, '0')}`;

    const [transaccionesRango, transaccionesPrevias, categoriasCatalogo, tarjetasCatalogo, extractos12M, flujoActual, estadoPersonas, prestamosActivos] =
      await Promise.all([
        this.prisma.transacciones.findMany({
          where: {
            owner_user_id: ownerUserId,
            estado: 'CONFIRMADO',
            fecha_transaccion: { gte: fechaInicio, lte: fechaFin },
            ...(cuentaIds.length > 0
              ? {
                  OR: [
                    { cuenta_origen_id: { in: cuentaIds.map((id) => BigInt(id)) } },
                    { cuenta_destino_id: { in: cuentaIds.map((id) => BigInt(id)) } },
                  ],
                }
              : {}),
            ...(categoriaIds.length > 0 ? { categoria_id: { in: categoriaIds.map((id) => BigInt(id)) } } : {}),
          },
          orderBy: { fecha_transaccion: 'asc' },
        }),
        this.prisma.transacciones.findMany({
          where: {
            owner_user_id: ownerUserId,
            estado: 'CONFIRMADO',
            fecha_transaccion: { gte: fechaInicioAnterior, lte: fechaFinAnterior },
            ...(cuentaIds.length > 0
              ? {
                  OR: [
                    { cuenta_origen_id: { in: cuentaIds.map((id) => BigInt(id)) } },
                    { cuenta_destino_id: { in: cuentaIds.map((id) => BigInt(id)) } },
                  ],
                }
              : {}),
            ...(categoriaIds.length > 0 ? { categoria_id: { in: categoriaIds.map((id) => BigInt(id)) } } : {}),
          },
        }),
        this.prisma.categorias.findMany({ where: { owner_user_id: ownerUserId } }),
        Promise.resolve(this.lookup.tarjetas(ownerUserId)).then((lista) =>
          lista.filter((t) => t.tipo !== 'DEBITO' && !t.esGenerica && (tarjetaIds.length === 0 || tarjetaIds.includes(t.id))),
        ),
        this.extractosPorTarjeta(ownerUserId, periodoRef),
        this.subledger.flujoCaja(periodoRef, ownerUserId),
        this.estadoCuentaPersonas.listar(ownerUserId, periodoRef),
        this.prisma.prestamos.findMany({
          where: {
            owner_user_id: ownerUserId,
            estado: 'Pendiente',
            ...(personaIds.length > 0 ? { responsable: { in: personaIds.map((id) => BigInt(id)) } } : {}),
          },
        }),
      ]);

    // 1. Serie Temporal (curva de flujo de caja & patrimonio con promedio móvil)
    const buckets = new Map<
      string,
      { ingresos: Decimal; gastosPropios: Decimal; gastosTerceros: Decimal; transferenciasInternas: Decimal }
    >();
    const claveBucket = (d: Date): string => {
      const iso = d.toISOString().slice(0, 10);
      if (granularidad === 'DIA') return iso;
      if (granularidad === 'SEMANA') {
        const copia = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dia = copia.getUTCDay() || 7;
        copia.setUTCDate(copia.getUTCDate() - dia + 1);
        return copia.toISOString().slice(0, 10);
      }
      return iso.slice(0, 7);
    };

    for (const tx of transaccionesRango) {
      const k = claveBucket(tx.fecha_transaccion);
      const b = buckets.get(k) ?? {
        ingresos: cero(),
        gastosPropios: cero(),
        gastosTerceros: cero(),
        transferenciasInternas: cero(),
      };
      const m = toDecimal(tx.monto_cop);
      const esInterna = Boolean((tx as { es_transferencia_interna?: boolean }).es_transferencia_interna) || tx.tipo_transaccion === 'TRANSFERENCIA';
      if (esInterna) {
        if (tx.tipo_transaccion === 'EGRESO' || tx.tipo_transaccion === 'TRANSFERENCIA') {
          b.transferenciasInternas = b.transferenciasInternas.plus(m);
        }
        if (incluirTransferenciasInternas) {
          if (tx.tipo_transaccion === 'INGRESO') b.ingresos = b.ingresos.plus(m);
          else b.gastosPropios = b.gastosPropios.plus(m);
        }
      } else if (tx.tipo_transaccion === 'INGRESO') {
        b.ingresos = b.ingresos.plus(m);
      } else if (tx.tipo_transaccion === 'EGRESO' || tx.tipo_transaccion === 'PAGO_TARJETA') {
        b.gastosPropios = b.gastosPropios.plus(m);
      }
      buckets.set(k, b);
    }

    // Incorporar cuotas de tarjetas en buckets mensuales cuando la granularidad es MES
    if (granularidad === 'MES') {
      for (const ex of extractos12M) {
        if (tarjetaIds.length > 0 && !tarjetaIds.includes(idNum(ex.tarjeta_id))) continue;
        const b = buckets.get(ex.periodo);
        if (!b) continue;
        const totalEx = toDecimal(ex.total);
        const tercerosEx = toDecimal(ex.terceros);
        const propioEx = Decimal.max(cero(), totalEx.minus(tercerosEx));
        b.gastosPropios = b.gastosPropios.plus(propioEx);
        if (!soloGastoPropio) {
          b.gastosTerceros = b.gastosTerceros.plus(tercerosEx);
        }
      }
    }

    const clavesOrdenadas = [...buckets.keys()].sort();
    const serieTemporal = clavesOrdenadas.map((clave, idx) => {
      const b = buckets.get(clave)!;
      const ventana = clavesOrdenadas.slice(Math.max(0, idx - 2), idx + 1).map((c) => buckets.get(c)!.gastosPropios);
      const promedioMovil = ventana.length > 0 ? money(suma(ventana).div(ventana.length)) : cero();
      return {
        periodo: clave,
        ingresos: money(b.ingresos),
        gastosPropios: money(b.gastosPropios),
        gastosTerceros: money(soloGastoPropio ? cero() : b.gastosTerceros),
        ahorroNeto: money(b.ingresos.minus(b.gastosPropios)),
        transferenciasInternas: money(b.transferenciasInternas),
        promedioMovilGastos: promedioMovil,
      };
    });

    // 2. Distribución por Categorías -> Top Comercios
    const mapaCatNombres = new Map<number, { nombre: string; color: string | null }>();
    for (const c of categoriasCatalogo) {
      mapaCatNombres.set(idNum(c.id), { nombre: c.nombre, color: c.color });
    }

    const gastosPorCatActual = new Map<number | null, { total: Decimal; comercios: Map<string, Decimal> }>();
    const gastosPorCatPrevio = new Map<number | null, Decimal>();

    for (const tx of transaccionesRango) {
      const esInterna = Boolean((tx as { es_transferencia_interna?: boolean }).es_transferencia_interna) || tx.tipo_transaccion === 'TRANSFERENCIA';
      if (esInterna && !incluirTransferenciasInternas) continue;
      if (tx.tipo_transaccion !== 'EGRESO' && tx.tipo_transaccion !== 'PAGO_TARJETA') continue;
      const catId = tx.categoria_id ? idNum(tx.categoria_id) : null;
      const m = toDecimal(tx.monto_cop);
      const entry = gastosPorCatActual.get(catId) ?? { total: cero(), comercios: new Map<string, Decimal>() };
      entry.total = entry.total.plus(m);
      const comercio = (tx.concepto || 'Otros').trim().slice(0, 60);
      entry.comercios.set(comercio, (entry.comercios.get(comercio) ?? cero()).plus(m));
      gastosPorCatActual.set(catId, entry);
    }

    for (const tx of transaccionesPrevias) {
      const esInterna = Boolean((tx as { es_transferencia_interna?: boolean }).es_transferencia_interna) || tx.tipo_transaccion === 'TRANSFERENCIA';
      if (esInterna && !incluirTransferenciasInternas) continue;
      if (tx.tipo_transaccion !== 'EGRESO' && tx.tipo_transaccion !== 'PAGO_TARJETA') continue;
      const catId = tx.categoria_id ? idNum(tx.categoria_id) : null;
      gastosPorCatPrevio.set(catId, (gastosPorCatPrevio.get(catId) ?? cero()).plus(toDecimal(tx.monto_cop)));
    }

    const totalGastoCategorias = suma([...gastosPorCatActual.values()].map((x) => x.total));
    const distribucionCategorias = [...gastosPorCatActual.entries()]
      .sort((a, b) => b[1].total.comparedTo(a[1].total))
      .map(([catId, info], idx) => {
        const meta = catId !== null ? mapaCatNombres.get(catId) : null;
        const previo = gastosPorCatPrevio.get(catId) ?? cero();
        const variacionPct = previo.greaterThan(0)
          ? Math.round(info.total.minus(previo).div(previo).times(1000).toNumber()) / 10
          : null;
        const porcentajeCat = totalGastoCategorias.greaterThan(0)
          ? Math.round(info.total.div(totalGastoCategorias).times(1000).toNumber()) / 10
          : 0;
        const comercios = [...info.comercios.entries()]
          .sort((a, b) => b[1].comparedTo(a[1]))
          .slice(0, 5)
          .map(([comercio, montoComercio]) => ({
            comercio,
            monto: money(montoComercio),
            porcentaje: info.total.greaterThan(0) ? Math.round(montoComercio.div(info.total).times(1000).toNumber()) / 10 : 0,
          }));
        return {
          categoriaId: catId,
          categoria: meta?.nombre ?? 'Sin categoría',
          color: meta?.color ?? COLORES_CATEGORIA_FALLBACK[idx % COLORES_CATEGORIA_FALLBACK.length],
          monto: money(info.total),
          porcentaje: porcentajeCat,
          variacionPct,
          comercios,
        };
      });

    // 3. Proyección de los próximos 12 meses de cuotas de tarjetas de crédito
    const mesesProyeccion: string[] = [];
    for (let i = 0; i < 12; i++) {
      mesesProyeccion.push(addMesesPeriodo(periodoRef, i));
    }

    const proyeccionCuotasTarjetas = mesesProyeccion.map((mes) => {
      const porTarjeta = tarjetasCatalogo.map((t) => {
        const fila = extractos12M.find((e) => idNum(e.tarjeta_id) === t.id && e.periodo === mes);
        const totalT = money(toDecimal(fila?.total));
        const tercerosT = money(toDecimal(fila?.terceros));
        const propiaT = money(Decimal.max(cero(), totalT.minus(tercerosT)));
        return {
          tarjetaId: t.id,
          etiqueta: t.etiqueta,
          partePropia: propiaT,
          parteTerceros: soloGastoPropio ? cero() : tercerosT,
          total: soloGastoPropio ? propiaT : totalT,
          cupoTotal: t.cupoTotal === null ? null : money(toDecimal(t.cupoTotal)),
        };
      });
      return {
        periodo: mes,
        partePropia: suma(porTarjeta.map((x) => x.partePropia)),
        parteTerceros: suma(porTarjeta.map((x) => x.parteTerceros)),
        total: suma(porTarjeta.map((x) => x.total)),
        porTarjeta,
      };
    });

    // 4. Mapa de calor de hábitos (Día de semana 1..7 x Semana del mes 1..5)
    const matrizCalor = new Map<string, { diaSemana: number; semanaMes: number; monto: Decimal; cantidad: number }>();
    for (const tx of transaccionesRango) {
      const esInterna = Boolean((tx as { es_transferencia_interna?: boolean }).es_transferencia_interna) || tx.tipo_transaccion === 'TRANSFERENCIA';
      if (esInterna && !incluirTransferenciasInternas) continue;
      if (tx.tipo_transaccion !== 'EGRESO') continue;
      const d = tx.fecha_transaccion;
      const diaSemana = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      const semanaMes = Math.min(5, Math.ceil(d.getUTCDate() / 7));
      const key = `${diaSemana}-${semanaMes}`;
      const actual = matrizCalor.get(key) ?? { diaSemana, semanaMes, monto: cero(), cantidad: 0 };
      actual.monto = actual.monto.plus(toDecimal(tx.monto_cop));
      actual.cantidad += 1;
      matrizCalor.set(key, actual);
    }
    const mapaCalorHabitos = [...matrizCalor.values()].map((c) => ({
      diaSemana: c.diaSemana,
      nombreDia: NOMBRES_DIA_SEMANA[c.diaSemana] ?? 'Día',
      semanaMes: c.semanaMes,
      monto: money(c.monto),
      cantidad: c.cantidad,
    }));

    // 5. Balance de Deudas y Préstamos
    const meDebenPrestamos = suma(
      prestamosActivos
        .filter((p) => (p.direccion_prestamo ?? 'POR_COBRAR') === 'POR_COBRAR')
        .map((p) => toDecimal(p.saldo_pendiente ?? p.valor_prestado)),
    );
    const deboPrestamosPasivos = suma(
      prestamosActivos
        .filter((p) => p.direccion_prestamo === 'POR_PAGAR')
        .map((p) => toDecimal(p.saldo_pendiente ?? p.valor_prestado)),
    );
    const totalPorCobrarSubledger = toDecimal(estadoPersonas.totales.deudaTotal);
    const meDebenTarjetasYCruce = Decimal.max(cero(), totalPorCobrarSubledger.minus(meDebenPrestamos));
    const tarjetasResumenActual = this.tarjetas(tarjetasCatalogo, extractos12M, periodoRef, hoy);
    const deboTarjetasPropias = suma(tarjetasResumenActual.map((t) => t.deudaPendienteMiParte));
    const totalMeDeben = money(meDebenPrestamos.plus(meDebenTarjetasYCruce));
    const totalDebo = money(deboTarjetasPropias.plus(deboPrestamosPasivos));

    // 6. Cascada Mensual (Waterfall)
    const ingresosMes = money(toDecimal(flujoActual.total_ingresos));
    const gastosFijosRecurrentes = money(toDecimal(flujoActual.total_esperado_recurrentes));
    const cuotasTarjetasBrutas = toDecimal(flujoActual.total_tarjetas);
    const porCobrarTercerosMes = toDecimal(flujoActual.total_por_cobrar_terceros);
    const cuotasTarjetasPropias = money(Decimal.max(cero(), cuotasTarjetasBrutas.minus(porCobrarTercerosMes)));
    const gastosVariablesDirectos = money(toDecimal(flujoActual.total_egresos_directos));
    const prestamosNeto = cero();
    const flujoLibreReal = money(toDecimal(flujoActual.flujo_caja_libre_estimado));

    return {
      filtrosAplicados: {
        fechaInicio: fechaInicio.toISOString().slice(0, 10),
        fechaFin: fechaFin.toISOString().slice(0, 10),
        granularidad,
        cuentaIds,
        tarjetaIds,
        categoriaIds,
        personaIds,
        soloGastoPropio,
        incluirTransferenciasInternas,
      },
      serieTemporal,
      distribucionCategorias,
      proyeccionCuotasTarjetas,
      mapaCalorHabitos,
      balanceDeudasYPrestamos: {
        meDebenPrestamos: money(meDebenPrestamos),
        meDebenTercerosTarjetasYCruces: money(meDebenTarjetasYCruce),
        totalMeDeben,
        deboTarjetasPropias,
        deboPrestamosPasivos: money(deboPrestamosPasivos),
        totalDebo,
        posicionNeta: money(totalMeDeben.minus(totalDebo)),
      },
      cascadaMensual: {
        ingresos: ingresosMes,
        gastosFijosRecurrentes,
        cuotasTarjetasPropias,
        gastosVariablesDirectos,
        prestamosNeto,
        flujoLibreReal,
      },
    };
  }

  // ───────────────────────────── bloques ─────────────────────────────

  /** Solo cuentas activas; las que no son en pesos se listan aparte (no se suman a un total en COP). */
  private liquidez(cuentas: ItemCuenta[]) {
    const activas = cuentas.filter((c) => c.activa);
    const cop = activas.filter((c) => c.moneda === 'COP');
    const otras = new Map<string, Decimal>();
    for (const c of activas.filter((x) => x.moneda !== 'COP')) otras.set(c.moneda, (otras.get(c.moneda) ?? cero()).plus(toDecimal(c.saldoActual)));
    return {
      total: suma(cop.map((c) => toDecimal(c.saldoActual))),
      moneda: 'COP',
      otrasMonedas: [...otras.entries()].map(([moneda, saldo]) => ({ moneda, saldo: money(saldo) })),
      cuentas: [...activas]
        .sort((a, b) => b.saldoActual - a.saldoActual)
        .map((c) => ({ id: c.id, nombre: c.nombre, tipo: c.tipoCuenta, moneda: c.moneda, saldo: money(toDecimal(c.saldoActual)), esPrincipal: c.esPrincipal })),
      numeroCuentas: activas.length,
    };
  }

  private tarjetas(items: ItemTarjeta[], extractos: FilaExtracto[], periodo: string, hoy: Date): TarjetaDashboard[] {
    return items
      .map((t) => {
        const filas = extractos.filter((e) => idNum(e.tarjeta_id) === t.id);
        const mes = filas.find((e) => e.periodo === periodo);
        const total = money(toDecimal(mes?.total));
        const terceros = money(toDecimal(mes?.terceros));
        const pendiente = suma(filas.map((e) => toDecimal(e.pendiente)));
        const vencidoSinRegistrar = suma(filas.filter((e) => e.periodo < periodo).map((e) => toDecimal(e.sin_pagar)));
        const pendienteTerceros = suma(filas.map((e) => toDecimal(e.pendiente_terceros)));
        const cupoUtilizado = suma(filas.map((e) => toDecimal(e.capital_pendiente)));
        const cupoTotal = t.cupoTotal === null ? null : money(toDecimal(t.cupoTotal));
        const pendientes: ExtractoPendiente[] = filas.filter((e) => toDecimal(e.sin_pagar).greaterThan(0)).map((e) => ({ periodo: e.periodo, monto: money(toDecimal(e.sin_pagar)).toNumber() }));
        const vencimientos = proximosVencimientos(hoy, pendientes, t.diaCorte, t.diaLimitePago);
        return {
          id: t.id,
          nombre: t.nombre,
          etiqueta: t.etiqueta,
          cupoTotal,
          cupoUtilizado,
          porcentajeCupo: cupoTotal && cupoTotal.greaterThan(0) ? Math.min(100, Math.round(cupoUtilizado.div(cupoTotal).times(1000).toNumber()) / 10) : null,
          diaCorte: t.diaCorte,
          diaLimitePago: t.diaLimitePago,
          pagoDelMes: total,
          miParte: money(total.minus(terceros)),
          terceros,
          deudaPendiente: pendiente,
          deudaPendienteMiParte: money(pendiente.minus(pendienteTerceros)),
          vencidoSinRegistrar,
          proximoVencimiento: vencimientos.find((v) => !v.vencido) ?? vencimientos[0] ?? null,
          esTitularExterno: t.esTitularExterno === true,
          titularPersonaId: t.titularPersonaId ?? null,
        };
      })
      .filter((t) => t.pagoDelMes.greaterThan(0) || t.deudaPendiente.greaterThan(0) || t.cupoUtilizado.greaterThan(0) || t.vencidoSinRegistrar.greaterThan(0) || t.cupoTotal !== null)
      .sort((a, b) => b.pagoDelMes.comparedTo(a.pagoDelMes) || b.deudaPendiente.comparedTo(a.deudaPendiente) || a.nombre.localeCompare(b.nombre));
  }

  private porCobrar(personas: Awaited<ReturnType<EstadoCuentaPersonasService['listar']>>) {
    const top = personas.personas
      .filter((p) => p.deudaTotal.greaterThan(0))
      .sort((a, b) => b.aPagarAhora.comparedTo(a.aPagarAhora) || b.deudaTotal.comparedTo(a.deudaTotal))
      .slice(0, 5)
      .map((p) => ({
        personaId: p.persona.id,
        nombre: p.persona.nombre,
        iniciales: p.persona.iniciales,
        color: p.persona.color,
        pagoDelMes: p.pagoDelMes,
        aPagarAhora: p.aPagarAhora,
        porVencer: p.porVencer,
        deudaTotal: p.deudaTotal,
      }));
    return {
      pagoDelMes: personas.totales.pagoDelMes,
      aPagarAhora: personas.totales.aPagarAhora,
      porVencer: personas.totales.porVencer,
      deudaTotal: personas.totales.deudaTotal,
      personasConDeuda: personas.personas.filter((p) => p.deudaTotal.greaterThan(0)).length,
      historicoSinCargar: personas.totales.historicoSinCargar,
      topDeudores: top,
    };
  }

  /** Un vencimiento por tarjeta (el más próximo), ordenados por fecha. */
  private vencimientos(tarjetas: TarjetaDashboard[]) {
    return tarjetas
      .filter((t) => t.proximoVencimiento)
      .map((t) => ({ tarjetaId: t.id, tarjeta: t.etiqueta, ...t.proximoVencimiento! }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .slice(0, 6);
  }

  // ───────────────────────────── consultas ─────────────────────────────

  /**
   * Por tarjeta y periodo de facturación: lo que cobra el banco, la parte de terceros (cada responsable paga su % solo de las
   * primeras `cantidad_cuotas`, como en el resumen mensual) y lo que sigue sin pagarse. Una sola pasada por las cuotas.
   * La deuda real son las cuotas del periodo consultado en adelante: las anteriores sin marcar pagadas (casi siempre ya se pagaron en
   * el banco y solo falta registrarlo) se separan en `sin_pagar` para no inflar la deuda.
   */
  private extractosPorTarjeta(ownerUserId: bigint, periodo: string): Promise<FilaExtracto[]> {
    return this.prisma.$queryRaw<FilaExtracto[]>(Prisma.sql`
      WITH mi_persona AS (
        SELECT id FROM "Personas" WHERE linked_user_id = ${ownerUserId}::int8 OR legacy_appsheet_id = ${LEGACY_YO} ORDER BY id LIMIT 1
      )
      SELECT cc.tarjeta AS tarjeta_id,
             ${PERIODO_CUOTA} AS periodo,
             SUM(cd.pago_total) AS total,
             SUM(cd.pago_total * (COALESCE(tr.pct, 0) / 100.0)) AS terceros,
             SUM(CASE WHEN ${NO_PAGADA} THEN cd.pago_total ELSE 0 END) AS sin_pagar,
             SUM(CASE WHEN ${NO_PAGADA} AND ${PERIODO_CUOTA} >= ${periodo}::text THEN cd.pago_total ELSE 0 END) AS pendiente,
             SUM(CASE WHEN ${NO_PAGADA} AND ${PERIODO_CUOTA} >= ${periodo}::text THEN cd.pago_total * (COALESCE(tr.pct, 0) / 100.0) ELSE 0 END) AS pendiente_terceros,
             SUM(CASE WHEN ${NO_PAGADA} AND ${PERIODO_CUOTA} >= ${periodo}::text THEN COALESCE(cd.aporte_capital, 0) ELSE 0 END) AS capital_pendiente
      FROM "ComprasCredito" cc
      JOIN "CuotasDetalle" cd ON cd.compra = cc.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(rcc.porcentaje_pago), 0) AS pct
        FROM "ResponsablesComprasCredito" rcc
        WHERE rcc.compra_credito = cc.id
          AND rcc.persona IS NOT NULL
          AND rcc.persona IS DISTINCT FROM (SELECT id FROM mi_persona)
          AND (rcc.cantidad_cuotas IS NULL OR cd.numero_cuota <= rcc.cantidad_cuotas)
      ) tr ON true
      WHERE cc.owner_user_id = ${ownerUserId}::int8
        AND cc.tarjeta IS NOT NULL
        AND ${PERIODO_CUOTA} IS NOT NULL
        AND UPPER(COALESCE(cd.estado, '')) <> 'REFINANCIADA' -- las cuotas de compras unificadas las cubre la obligación nueva
      GROUP BY cc.tarjeta, ${PERIODO_CUOTA}`);
  }

  private async movimientosRecientes(ownerUserId: bigint) {
    const filas = await this.prisma.$queryRaw<FilaMovimiento[]>(Prisma.sql`
      SELECT t.id, t.fecha_transaccion, t.concepto, t.tipo_transaccion, t.monto_cop, t.estado,
             co.nombre AS cuenta_origen, cd.nombre AS cuenta_destino
      FROM "Transacciones" t
      LEFT JOIN "CuentasFinancieras" co ON co.id = t.cuenta_origen_id
      LEFT JOIN "CuentasFinancieras" cd ON cd.id = t.cuenta_destino_id
      WHERE t.owner_user_id = ${ownerUserId}::int8 AND COALESCE(t.estado, 'CONFIRMADO') <> 'ANULADO'
      ORDER BY t.fecha_transaccion DESC, t.id DESC
      LIMIT 8`);
    return filas.map((f) => ({
      id: idNum(f.id),
      fecha: f.fecha_transaccion.toISOString(),
      concepto: f.concepto,
      tipo: f.tipo_transaccion,
      monto: money(toDecimal(f.monto_cop)),
      estado: f.estado,
      cuenta: f.cuenta_origen ?? f.cuenta_destino,
    }));
  }

  /** Cosas que esperan una acción tuya: movimientos por revisar, correos sin conciliar y pagos reportados por aprobar. */
  private async alertas(ownerUserId: bigint) {
    const [porRevisar, correos, pagos] = await Promise.all([
      this.prisma.transacciones.count({ where: { owner_user_id: ownerUserId, estado: 'PENDIENTE_REVISION' } }),
      this.prisma.notificacionesCorreo.count({ where: { owner_user_id: ownerUserId, estado_procesamiento: 'PENDIENTE' } }),
      this.prisma.reportesPagoPersona.count({ where: { owner_user_id: ownerUserId, estado: 'PENDIENTE' } }),
    ]);
    return { movimientosPorRevisar: porRevisar, correosPendientes: correos, pagosPorAprobar: pagos };
  }
}
