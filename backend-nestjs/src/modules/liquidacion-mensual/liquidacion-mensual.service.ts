import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoMovimientoDeuda, TipoMovimientoDeuda } from '../../common/enums/finance.enums';
import { isValidPeriodo, parseIsoDate, periodoActual, periodoOf, todayLocal } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertPersona } from '../../common/utils/ownership.util';
import { ultimoDiaPeriodo } from '../../common/utils/periodo.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { calcularEstadoPeriodo } from '../obligaciones-aportes/aportes-carro.calc';
import { RecurrentesPersonaService } from '../recurrentes-persona/recurrentes-persona.service';
import { SubledgerDeudasService } from '../subledger-deudas/subledger-deudas.service';
import { CruceEntrePersonasDto, RegistrarPagoMesDto } from './dto/liquidacion.dto';
import { CuotasTercerosService, CuotaTercero, estadoDeCuota } from './cuotas-terceros.service';

export type OrigenMovimiento =
  | 'COMPRA_CREDITO'
  | 'PRESTAMO'
  | 'RECURRENTE_COMPARTIDO'
  | 'RECURRENTE_PERSONA'
  | 'COBRO_PUNTUAL'
  | 'CRUCE_APORTE_CARRO'
  | 'CRUCE_ENTRE_PERSONAS'
  | 'SALDO_A_FAVOR_CARRO'
  | 'PAGO_RECIBIDO'
  | 'DESCUENTO'
  | 'OTRO';

type Categoria = 'cuotasTarjetas' | 'cuotasPrestamos' | 'cargosRecurrentes' | 'cobrosPuntuales' | 'crucesCuentas' | 'saldoAFavorAplicado' | 'abonosRealizados' | 'otros';

const CATEGORIAS: Categoria[] = ['cuotasTarjetas', 'cuotasPrestamos', 'cargosRecurrentes', 'cobrosPuntuales', 'crucesCuentas', 'saldoAFavorAplicado', 'abonosRealizados', 'otros'];

const PERSONA_SELECT = { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } as const;

/** Lo que se lee de cada asiento para armar el detalle: el préstamo, la compra/cuota con su porcentaje y el cobro puntual. */
const INCLUDE_MOVIMIENTO = {
  prestamo: { select: { origen_cruce_aporte_id: true, comentarios: true } },
  responsable_compra: { select: { porcentaje_pago: true, cantidad_cuotas: true } },
  cuota_detalle: {
    select: {
      numero_cuota: true,
      pago_total: true,
      compra_ref: {
        select: { concepto: true, valor_compra: true, fecha_compra: true, numero_cuotas: true, tarjeta_ref: { select: { franquicia: true, descripcion: true } } },
      },
    },
  },
  cobro_puntual: { select: { concepto: true, categoria: true, monto_total: true, modo_division: true, notas: true } },
} satisfies Prisma.MovimientosDeudaPersonaInclude;

type Movimiento = Prisma.MovimientosDeudaPersonaGetPayload<{ include: typeof INCLUDE_MOVIMIENTO }>;

/** A qué bloque de la liquidación pertenece un asiento del sub-ledger. */
export function categoriaDeMovimiento(tipo: string, signo: number): Categoria {
  switch (tipo) {
    case TipoMovimientoDeuda.CARGO_CUOTA_TC:
      return 'cuotasTarjetas';
    case TipoMovimientoDeuda.CARGO_PRESTAMO_DIRECTO:
      return 'cuotasPrestamos';
    case TipoMovimientoDeuda.CARGO_GASTO_COMPARTIDO:
    case TipoMovimientoDeuda.CARGO_RECURRENTE_PERSONA:
    case TipoMovimientoDeuda.ABONO_RECURRENTE_PERSONA:
      return 'cargosRecurrentes';
    case TipoMovimientoDeuda.CARGO_COBRO_PUNTUAL:
      return 'cobrosPuntuales';
    case TipoMovimientoDeuda.CARGO_CRUCE_DEUDA:
    case TipoMovimientoDeuda.ABONO_CRUCE_DEUDA:
      return 'crucesCuentas';
    case TipoMovimientoDeuda.ABONO_SALDO_FAVOR_CARRO:
      return 'saldoAFavorAplicado';
    case TipoMovimientoDeuda.ABONO_PAGO_RECIBIDO:
    case TipoMovimientoDeuda.ABONO_APORTE_DIARIO:
    case TipoMovimientoDeuda.AJUSTE_DESCUENTO:
      return 'abonosRealizados';
    default:
      return signo < 0 ? 'abonosRealizados' : 'otros';
  }
}

/** Origen funcional del asiento (la taxonomía de la especificación) a partir del tipo y de sus referencias. */
export function origenDeMovimiento(m: Pick<Movimiento, 'tipo_movimiento' | 'cruce_deuda_id'> & { prestamo?: { origen_cruce_aporte_id: bigint | null } | null }): OrigenMovimiento {
  switch (m.tipo_movimiento) {
    case TipoMovimientoDeuda.CARGO_CUOTA_TC:
      return 'COMPRA_CREDITO';
    case TipoMovimientoDeuda.CARGO_PRESTAMO_DIRECTO:
      return 'PRESTAMO';
    case TipoMovimientoDeuda.CARGO_GASTO_COMPARTIDO:
      return 'RECURRENTE_COMPARTIDO';
    case TipoMovimientoDeuda.CARGO_RECURRENTE_PERSONA:
    case TipoMovimientoDeuda.ABONO_RECURRENTE_PERSONA:
      return 'RECURRENTE_PERSONA';
    case TipoMovimientoDeuda.CARGO_COBRO_PUNTUAL:
      return 'COBRO_PUNTUAL';
    case TipoMovimientoDeuda.CARGO_CRUCE_DEUDA:
      if (m.cruce_deuda_id !== null) return 'CRUCE_ENTRE_PERSONAS';
      return m.prestamo?.origen_cruce_aporte_id ? 'CRUCE_APORTE_CARRO' : 'PRESTAMO';
    case TipoMovimientoDeuda.ABONO_CRUCE_DEUDA:
      return 'CRUCE_ENTRE_PERSONAS';
    case TipoMovimientoDeuda.ABONO_SALDO_FAVOR_CARRO:
      return 'SALDO_A_FAVOR_CARRO';
    case TipoMovimientoDeuda.ABONO_PAGO_RECIBIDO:
      return 'PAGO_RECIBIDO';
    case TipoMovimientoDeuda.AJUSTE_DESCUENTO:
      return 'DESCUENTO';
    default:
      return 'OTRO';
  }
}

const sumaImpacto = (items: Array<{ impacto: Decimal }>): Decimal => money(items.reduce((acc, i) => acc.plus(i.impacto), new Decimal(0)));

/**
 * Liquidación de fin de mes por persona («¿cuánto me debe Andrés / mi papá?»).
 *
 *   Total a cobrar   = cargos del mes (tarjetas, préstamos, recurrentes, cruces en contra) + faltante de la cuota del carro
 *   Total a favor    = abonos del mes (pagos, cruces a favor, recurrentes a favor, saldo a favor aplicado)
 *   Saldo neto final = Total a cobrar − Total a favor     (> 0 «te debe», < 0 «saldo a favor», 0 «paz y salvo»)
 *
 * Todo sale del sub-ledger (`MovimientosDeudaPersona`, que alimentan los triggers) más el faltante de las obligaciones del
 * mes, que se calcula al vuelo. Antes de leer se generan los cargos recurrentes del mes (idempotente).
 */
@Injectable()
export class LiquidacionMensualService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recurrentes: RecurrentesPersonaService,
    private readonly subledger: SubledgerDeudasService,
    private readonly cuotasTerceros: CuotasTercerosService,
  ) {}

  async liquidacion(periodo: string, ownerUserId: bigint, opciones: { personaId?: number; todas?: boolean } = {}) {
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    const generacion = await this.recurrentes.asegurarMes(periodo, ownerUserId);

    const filtroPersona = opciones.personaId !== undefined ? { persona_id: BigInt(opciones.personaId) } : {};
    const vigente = { OR: [{ estado: null }, { estado: { not: EstadoMovimientoDeuda.ANULADO } }] };

    const [personas, movimientos, previos, obligaciones, cuotas] = await Promise.all([
      this.prisma.personas.findMany({
        where: { owner_user_id: ownerUserId, ...(opciones.personaId !== undefined ? { id: BigInt(opciones.personaId) } : {}) },
        select: PERSONA_SELECT,
        orderBy: { id: 'asc' },
      }),
      this.prisma.movimientosDeudaPersona.findMany({
        where: { owner_user_id: ownerUserId, periodo_imputacion: periodo, ...filtroPersona, ...vigente },
        include: INCLUDE_MOVIMIENTO,
        orderBy: [{ fecha_movimiento: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.movimientosDeudaPersona.groupBy({
        by: ['persona_id', 'signo'],
        where: { owner_user_id: ownerUserId, periodo_imputacion: { lt: periodo }, estado: EstadoMovimientoDeuda.CONFIRMADO, ...filtroPersona },
        _sum: { monto: true },
      }),
      this.prisma.obligacionesMes.findMany({
        where: { owner_user_id: ownerUserId, periodo, ...(opciones.personaId !== undefined ? { responsable_principal_id: BigInt(opciones.personaId) } : {}) },
        include: { dias: { select: { detalles: { select: { valor: true } } } } },
        orderBy: { id: 'asc' },
      }),
      this.cuotasTerceros.listar(ownerUserId, { personaId: opciones.personaId }),
    ]);

    if (opciones.personaId !== undefined && personas.length === 0) throw new NotFoundException(`Persona ${opciones.personaId} no encontrada`);

    const movsPorPersona = new Map<bigint, Movimiento[]>();
    for (const m of movimientos) movsPorPersona.set(m.persona_id, [...(movsPorPersona.get(m.persona_id) ?? []), m]);

    // Cuotas de tarjeta del mes que aún no tienen su asiento en el sub-ledger (compras anteriores a los triggers): se cuentan igual.
    const virtualesPorPersona = new Map<bigint, CuotaTercero[]>();
    for (const c of cuotas) {
      if (c.periodo === periodo && c.movimientoId === null) virtualesPorPersona.set(c.personaId, [...(virtualesPorPersona.get(c.personaId) ?? []), c]);
    }

    const saldoAnterior = new Map<bigint, Decimal>();
    for (const g of previos) {
      const monto = toDecimal(g._sum.monto);
      saldoAnterior.set(g.persona_id, (saldoAnterior.get(g.persona_id) ?? new Decimal(0)).plus(monto.times(g.signo)));
    }

    const obligacionesPorPersona = new Map<bigint, ReturnType<LiquidacionMensualService['vistaObligacion']>[]>();
    for (const o of obligaciones) {
      obligacionesPorPersona.set(o.responsable_principal_id, [...(obligacionesPorPersona.get(o.responsable_principal_id) ?? []), this.vistaObligacion(o)]);
    }

    const resultado = personas
      .map((p) => this.liquidarPersona(p, movsPorPersona.get(p.id) ?? [], obligacionesPorPersona.get(p.id) ?? [], saldoAnterior.get(p.id) ?? new Decimal(0), virtualesPorPersona.get(p.id) ?? []))
      .filter((l) => opciones.todas || opciones.personaId !== undefined || l.tieneActividad)
      .sort((a, b) => b.resumenNeto.saldoNetoFinal.comparedTo(a.resumenNeto.saldoNetoFinal));

    const totalCargos = money(resultado.reduce((acc, l) => acc.plus(l.resumenNeto.totalCargos), new Decimal(0)));
    const totalAbonos = money(resultado.reduce((acc, l) => acc.plus(l.resumenNeto.totalAbonosYFavor), new Decimal(0)));
    return {
      periodo,
      recurrentesGenerados: generacion.movimientosGenerados,
      personas: resultado,
      totales: { totalCargos, totalAbonosYFavor: totalAbonos, saldoNetoFinal: money(totalCargos.minus(totalAbonos)) },
    };
  }

  async liquidacionPersona(periodo: string, personaId: number, ownerUserId: bigint) {
    const r = await this.liquidacion(periodo, ownerUserId, { personaId });
    return { periodo, ...r.personas[0] };
  }

  /** `POST /cruce-entre-personas`: abona a una persona y carga a la otra en una sola operación (Trigger 5). */
  async cruceEntrePersonas(dto: CruceEntrePersonasDto, ownerUserId: bigint) {
    let fecha: string | undefined = dto.fecha;
    if (fecha) {
      if (!parseIsoDate(fecha)) throw datosInvalidos({ fecha: ['fecha debe tener formato yyyy-MM-dd'] });
      if (dto.periodo && periodoOf(parseIsoDate(fecha) as Date) !== dto.periodo) {
        throw datosInvalidos({ fecha: [`La fecha no pertenece al periodo ${dto.periodo}`] });
      }
    } else if (dto.periodo && dto.periodo !== periodoActual()) {
      fecha = ultimoDiaPeriodo(dto.periodo).toISOString().slice(0, 10);
    }
    return this.subledger.crearCruce(
      {
        personaQueAbonaId: dto.personaOrigenId,
        personaQueAsumeDeudaId: dto.personaDestinoId,
        monto: dto.monto,
        fechaCruce: fecha,
        concepto: dto.concepto,
        comentarios: dto.comentarios,
        prestamoDestinoId: dto.prestamoDestinoId,
      },
      ownerUserId,
    );
  }

  /** `POST /registrar-pago`: con cuenta usa `sp_registrar_abono_persona` (transacción + abono); sin cuenta solo anota el abono. */
  async registrarPago(dto: RegistrarPagoMesDto, ownerUserId: bigint) {
    const periodo = dto.periodo ?? periodoActual();
    const concepto = dto.concepto?.trim() || `Pago de fin de mes ${periodo}`;
    if (dto.cuentaDestinoId !== undefined) {
      return this.subledger.abonarPersona(
        dto.personaId,
        { cuentaDestinoId: dto.cuentaDestinoId, monto: dto.monto, periodoImputacion: periodo, concepto, liquidarPrestamosCorteId: dto.liquidarPrestamosCorteId },
        ownerUserId,
      );
    }
    if (dto.liquidarPrestamosCorteId !== undefined) {
      throw datosInvalidos({ cuentaDestinoId: ['Para liquidar los préstamos de un corte indica la cuenta donde recibes el pago'] });
    }
    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });
    const movimiento = await this.prisma.$transaction(async (tx) => {
      await assertPersona(tx, dto.personaId, ownerUserId);
      return tx.movimientosDeudaPersona.create({
        data: {
          owner_user_id: ownerUserId,
          persona_id: BigInt(dto.personaId),
          fecha_movimiento: todayLocal(),
          periodo_imputacion: periodo,
          tipo_movimiento: TipoMovimientoDeuda.ABONO_PAGO_RECIBIDO,
          signo: -1,
          monto: toDbMoney(monto),
          concepto,
          estado: EstadoMovimientoDeuda.CONFIRMADO,
        },
      });
    });
    return { movimientoId: Number(movimiento.id), personaId: dto.personaId, monto: monto.toNumber(), periodoImputacion: periodo };
  }

  // ───────────────────────────── cálculo ─────────────────────────────

  private vistaObligacion(o: Prisma.ObligacionesMesGetPayload<{ include: { dias: { select: { detalles: { select: { valor: true } } } } } }>) {
    const estado = calcularEstadoPeriodo(o.meta_mensual, o.dias.flatMap((d) => d.detalles.map((x) => x.valor)), o.saldo_a_favor_aplicado);
    return { obligacionMesId: o.id, tipoObligacion: o.tipo_obligacion, periodo: o.periodo, concepto: o.concepto, ...estado };
  }

  private liquidarPersona(
    persona: { id: bigint; nombre: string | null; iniciales_nombre: string | null; color_representativo: string | null },
    movimientos: Movimiento[],
    obligaciones: Array<ReturnType<LiquidacionMensualService['vistaObligacion']>>,
    saldoAnterior: Decimal,
    cuotasSinAsiento: CuotaTercero[] = [],
  ) {
    const grupos = Object.fromEntries(CATEGORIAS.map((c) => [c, [] as ReturnType<LiquidacionMensualService['vistaItem']>[]])) as Record<Categoria, ReturnType<LiquidacionMensualService['vistaItem']>[]>;
    for (const m of movimientos) grupos[categoriaDeMovimiento(m.tipo_movimiento, m.signo)].push(this.vistaItem(m));
    for (const c of cuotasSinAsiento) grupos.cuotasTarjetas.push(this.vistaCuotaSinAsiento(c));
    grupos.cuotasTarjetas.sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.id - b.id);

    const items = CATEGORIAS.flatMap((c) => grupos[c]);
    const cargosLedger = money(items.filter((i) => i.signo > 0).reduce((acc, i) => acc.plus(i.monto), new Decimal(0)));
    const abonosLedger = money(items.filter((i) => i.signo < 0).reduce((acc, i) => acc.plus(i.monto), new Decimal(0)));
    const faltante = money(obligaciones.reduce((acc, o) => acc.plus(o.saldoPendiente), new Decimal(0)));

    const totalCargos = money(cargosLedger.plus(faltante));
    const totalAbonosYFavor = abonosLedger;
    const saldoNetoFinal = money(totalCargos.minus(totalAbonosYFavor));
    const estado = saldoNetoFinal.greaterThan(0) ? 'DEBE' : saldoNetoFinal.isNegative() ? 'A_FAVOR' : 'PAZ_Y_SALVO';

    const bloque = (categoria: Categoria) => ({ items: grupos[categoria], subtotal: sumaImpacto(grupos[categoria]) });
    return {
      persona: { id: persona.id, nombre: persona.nombre, iniciales: persona.iniciales_nombre, color: persona.color_representativo },
      cuotasTarjetas: bloque('cuotasTarjetas'),
      cuotasPrestamos: bloque('cuotasPrestamos'),
      cargosRecurrentes: bloque('cargosRecurrentes'),
      cobrosPuntuales: bloque('cobrosPuntuales'),
      crucesCuentas: bloque('crucesCuentas'),
      saldoAFavorAplicado: bloque('saldoAFavorAplicado'),
      abonosRealizados: bloque('abonosRealizados'),
      otros: bloque('otros'),
      estadoAporteCarro: obligaciones.find((o) => o.tipoObligacion === 'CUOTA_CARRO') ?? obligaciones[0] ?? null,
      obligaciones,
      faltanteObligacion: faltante,
      resumenNeto: { totalCargos, totalAbonosYFavor, saldoNetoFinal, estado },
      saldoAnterior: money(saldoAnterior),
      saldoTotalAcumulado: money(saldoAnterior.plus(saldoNetoFinal)),
      tieneActividad: items.length > 0 || !saldoAnterior.isZero() || faltante.greaterThan(0) || obligaciones.length > 0,
    };
  }

  /**
   * Cuota de una compra con tarjeta que le toca a la persona pero aún no tiene asiento en el sub-ledger (compra anterior a los
   * triggers). Misma forma que un asiento real; `virtual: true` y `id` negativo (`-cuota_detalle_id`) para no chocar con ids reales.
   */
  private vistaCuotaSinAsiento(c: CuotaTercero) {
    const tarjeta = c.tarjeta;
    return {
      id: -Number(c.cuotaId),
      fecha: c.fechaPago,
      concepto: `Cuota ${c.numeroCuota}/${c.numeroCuotasCompra} - ${c.concepto ?? 'Compra TC'}`,
      comentario: null as string | null,
      tipoMovimiento: TipoMovimientoDeuda.CARGO_CUOTA_TC as string,
      origen: 'COMPRA_CREDITO' as OrigenMovimiento,
      signo: 1,
      monto: c.monto,
      impacto: c.monto,
      estado: estadoDeCuota(c.numeroCuota, c.periodo) as string | null,
      prestamoId: null as bigint | null,
      cruceDeudaId: null as bigint | null,
      cargoRecurrentePersonaId: null as bigint | null,
      obligacionMesId: null as bigint | null,
      cuotaDetalleId: c.cuotaId as bigint | null,
      cobroPuntualId: null as bigint | null,
      virtual: true,
      detalle: {
        tipo: 'CUOTA_TARJETA' as const,
        compra: c.concepto,
        fechaCompra: c.fechaCompra,
        valorCompra: c.valorCompra as Decimal | null,
        numeroCuota: c.numeroCuota as number | null,
        cuotasDeLaCompra: c.numeroCuotasCompra as number | null,
        cuotasQueTePertenecen: c.cuotasDeLaPersona ?? c.numeroCuotasCompra,
        porcentaje: c.porcentaje as Decimal | null,
        valorCuotaTotal: c.pagoTotal as Decimal | null,
        tarjeta,
      },
    };
  }

  private vistaItem(m: Movimiento) {
    const monto = money(toDecimal(m.monto));
    return {
      id: Number(m.id),
      fecha: m.fecha_movimiento,
      concepto: m.concepto,
      comentario: m.prestamo?.comentarios ?? null,
      tipoMovimiento: m.tipo_movimiento,
      origen: origenDeMovimiento(m),
      signo: m.signo,
      monto,
      impacto: money(monto.times(m.signo)),
      estado: m.estado,
      prestamoId: m.prestamo_id,
      cruceDeudaId: m.cruce_deuda_id,
      cargoRecurrentePersonaId: m.cargo_recurrente_persona_id,
      obligacionMesId: m.obligacion_mes_id,
      cuotaDetalleId: m.cuota_detalle_id,
      cobroPuntualId: m.cobro_puntual_id,
      detalle: this.detalleItem(m),
    };
  }

  /** Para «¿por qué me cobran esto?»: de qué compra es la cuota, qué porcentaje y cuántas cuotas le tocan; o de qué gasto repartido es la parte. */
  private detalleItem(m: Movimiento) {
    if (m.cuota_detalle?.compra_ref) {
      const c = m.cuota_detalle.compra_ref;
      const tarjeta = [c.tarjeta_ref?.franquicia, c.tarjeta_ref?.descripcion].filter(Boolean).join(' · ') || null;
      return {
        tipo: 'CUOTA_TARJETA' as const,
        compra: c.concepto,
        fechaCompra: c.fecha_compra,
        valorCompra: c.valor_compra === null ? null : money(toDecimal(c.valor_compra)),
        numeroCuota: m.cuota_detalle.numero_cuota === null ? null : Number(m.cuota_detalle.numero_cuota),
        cuotasDeLaCompra: c.numero_cuotas,
        cuotasQueTePertenecen: m.responsable_compra?.cantidad_cuotas ?? c.numero_cuotas,
        porcentaje: m.responsable_compra?.porcentaje_pago === null || m.responsable_compra?.porcentaje_pago === undefined ? null : toDecimal(m.responsable_compra.porcentaje_pago),
        valorCuotaTotal: m.cuota_detalle.pago_total === null ? null : money(toDecimal(m.cuota_detalle.pago_total)),
        tarjeta,
      };
    }
    if (m.cobro_puntual) {
      return {
        tipo: 'COBRO_PUNTUAL' as const,
        categoria: m.cobro_puntual.categoria,
        montoTotal: money(toDecimal(m.cobro_puntual.monto_total)),
        modoDivision: m.cobro_puntual.modo_division,
        notas: m.cobro_puntual.notas,
      };
    }
    return null;
  }
}
