import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoMovimientoDeuda, TipoMovimientoDeuda } from '../../common/enums/finance.enums';
import { isValidPeriodo, periodoActual } from '../../common/utils/date.util';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { CuotaTercero, CuotasTercerosService } from '../liquidacion-mensual/cuotas-terceros.service';
import { LiquidacionMensualService } from '../liquidacion-mensual/liquidacion-mensual.service';
import { aplicarAbonosFifo, CargoAplicable, Cobertura } from './aplicacion-abonos';

type PersonaLiquidada = Awaited<ReturnType<LiquidacionMensualService['liquidacion']>>['personas'][number];

const cero = () => new Decimal(0);
const suma = (xs: Decimal[]): Decimal => money(xs.reduce((a, x) => a.plus(x), cero()));

export interface CompraDeLaPersona {
  compraId: number;
  concepto: string | null;
  fechaCompra: Date | null;
  valorCompra: Decimal;
  numeroCuotasCompra: number;
  /** Cuántas cuotas le tocan a la persona (las primeras N). */
  cuotasDeLaPersona: number;
  porcentaje: Decimal;
  /** Últimos 4 dígitos del plástico con el que se hizo la compra (si se sabe). */
  plastico: string | null;
  /** La cuota que vence en el periodo consultado (`null` si ese mes no le toca ninguna de esta compra). */
  cuotaDelMes: { numero: number; monto: Decimal; fechaPago: Date; estado: string; cubierto: Decimal; pendiente: Decimal } | null;
  /** Lo que queda por pagar de esta compra después del periodo consultado. */
  restantes: { cuotas: number; monto: Decimal };
}

export interface DesgloseTarjeta {
  tarjetaId: number | null;
  tarjeta: string | null;
  /** Lo que esta persona paga este mes por las compras con esta tarjeta. */
  totalMes: Decimal;
  /** Lo que le queda por pagar de las cuotas de los meses siguientes. */
  porVencer: Decimal;
  compras?: CompraDeLaPersona[];
  /** Compras de la tarjeta que tienen una cuota este mes o más adelante. */
  numeroCompras: number;
}

/**
 * Estado de cuenta por persona: «¿cuánto me debe?» sumando TODO lo que le toca —cuotas de lo que compré con mi tarjeta (según su
 * porcentaje y cuántas cuotas le corresponden), préstamos, gastos compartidos y recurrentes, cobros puntuales y cruces— menos lo que
 * ya pagó.
 *
 * Las cuotas de tarjeta se calculan siempre desde las compras (`CuotasTercerosService`): crear, editar o borrar una compra o sus
 * responsables cambia el estado de cuenta al instante, y las compras anteriores a los triggers (sin asiento en el sub-ledger) también
 * cuentan. El resto sale del sub-ledger; el saldo anterior es el explícito (asientos firmes de meses previos) para no inventar deudas:
 * las cuotas de meses pasados sin asiento se reportan aparte (`historicoSinCargar`) para que el usuario decida.
 */
@Injectable()
export class EstadoCuentaPersonasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liquidacion: LiquidacionMensualService,
    private readonly cuotasTerceros: CuotasTercerosService,
  ) {}

  /** Resumen de todas las personas con deuda, saldo o movimientos (o todas, con `todas`). */
  async listar(ownerUserId: bigint, periodoPedido: string | undefined, opciones: { todas?: boolean } = {}) {
    const periodo = this.validarPeriodo(periodoPedido);
    const [liq, cuotas, futurosOtros] = await Promise.all([
      this.liquidacion.liquidacion(periodo, ownerUserId, { todas: true }),
      this.cuotasTerceros.listar(ownerUserId),
      this.porVencerOtros(ownerUserId, periodo),
    ]);
    const cuotasPorPersona = this.agrupar(cuotas, (c) => c.personaId);

    const personas = liq.personas
      .map((l) => this.resumir(l, cuotasPorPersona.get(l.persona.id) ?? [], periodo, futurosOtros.get(l.persona.id) ?? cero(), false))
      .filter((r) => opciones.todas || r.tieneActividad)
      .sort((a, b) => b.deudaTotal.comparedTo(a.deudaTotal) || (a.persona.nombre ?? '').localeCompare(b.persona.nombre ?? ''));

    return {
      periodo,
      personas,
      totales: {
        pagoDelMes: suma(personas.map((p) => p.pagoDelMes)),
        aPagarAhora: suma(personas.map((p) => p.aPagarAhora)),
        porVencer: suma(personas.map((p) => p.porVencer)),
        deudaTotal: suma(personas.map((p) => p.deudaTotal)),
        historicoSinCargar: {
          cuotas: personas.reduce((n, p) => n + p.historicoSinCargar.cuotas, 0),
          monto: suma(personas.map((p) => p.historicoSinCargar.monto)),
        },
      },
    };
  }

  /** Detalle de una persona: resumen + compras de cada tarjeta (cuota k de N, porcentaje, qué cuotas quedan saldadas) + lo demás. */
  async detalle(ownerUserId: bigint, personaId: number, periodoPedido: string | undefined) {
    const periodo = this.validarPeriodo(periodoPedido);
    const [liq, cuotas, futurosOtros, abonos] = await Promise.all([
      this.liquidacion.liquidacion(periodo, ownerUserId, { personaId }),
      this.cuotasTerceros.listar(ownerUserId, { personaId }),
      this.porVencerOtros(ownerUserId, periodo, personaId),
      this.movimientosParaAplicar(ownerUserId, personaId, periodo),
    ]);
    const l = liq.personas[0];
    if (!l) throw new NotFoundException(`Persona ${personaId} no encontrada`);

    const resumen = this.resumir(l, cuotas, periodo, futurosOtros.get(l.persona.id) ?? cero(), true);

    // ¿Qué quedó saldado? Se aplican los abonos a los cargos del más antiguo al más nuevo.
    const cargos: CargoAplicable[] = [
      ...cuotas.filter((c) => c.periodo === periodo || (c.periodo < periodo && c.movimientoEstado === EstadoMovimientoDeuda.CONFIRMADO)).map((c) => ({
        clave: `cuota-${c.cuotaId}-${c.responsableId}`,
        periodo: c.periodo,
        // dentro de un mismo mes se salda primero la compra más antigua
        fecha: c.fechaCompra ?? c.fechaPago,
        monto: c.monto,
      })),
      ...abonos.cargos,
      ...(l.faltanteObligacion.greaterThan(0) ? [{ clave: 'faltante-obligacion', periodo, fecha: new Date(`${periodo}-28T00:00:00Z`), monto: l.faltanteObligacion }] : []),
    ];
    const { coberturas } = aplicarAbonosFifo(cargos, abonos.totalAbonos);

    return {
      ...resumen,
      desglosePorTarjeta: this.desglosarPorTarjeta(cuotas, periodo, coberturas),
      cuotasAnterioresPendientes: this.cuotasAnteriores(cuotas, periodo, coberturas),
      otrosCargos: {
        prestamos: l.cuotasPrestamos,
        recurrentes: l.cargosRecurrentes,
        cobrosPuntuales: l.cobrosPuntuales,
        cruces: l.crucesCuentas,
        saldoAFavorAplicado: l.saldoAFavorAplicado,
        otros: l.otros,
      },
      abonos: l.abonosRealizados,
      estadoAporteCarro: l.estadoAporteCarro,
      faltanteObligacion: l.faltanteObligacion,
      sobranteDeAbonos: aplicarAbonosFifo(cargos, abonos.totalAbonos).sobrante,
    };
  }

  // ───────────────────────────── cálculo ─────────────────────────────

  private resumir(l: PersonaLiquidada, cuotas: CuotaTercero[], periodo: string, porVencerOtros: Decimal, conCompras: boolean) {
    const mes = cuotas.filter((c) => c.periodo === periodo);
    const futuras = cuotas.filter((c) => c.periodo > periodo);
    const historicas = cuotas.filter((c) => c.periodo < periodo && c.movimientoId === null);

    const porVencerTarjetas = suma(futuras.map((c) => c.monto));
    const porVencer = money(porVencerTarjetas.plus(porVencerOtros));
    const saldoExigible = l.saldoTotalAcumulado;
    const total = money(saldoExigible.plus(porVencer));
    const tarjetasMes = suma(mes.map((c) => c.monto));

    return {
      persona: { id: Number(l.persona.id), nombre: l.persona.nombre, iniciales: l.persona.iniciales, color: l.persona.color },
      periodo,
      /** Lo que se le cobra por este mes: cuotas de tarjeta, préstamos, recurrentes, cobros puntuales y cruces (+ faltante de la cuota del carro). */
      pagoDelMes: l.resumenNeto.totalCargos,
      /** De ese total, lo que viene de compras con tarjeta. */
      pagoDelMesTarjetas: tarjetasMes,
      abonosDelMes: l.resumenNeto.totalAbonosYFavor,
      saldoAnterior: l.saldoAnterior,
      /** Lo que debe pagar ahora (saldo anterior + este mes − lo ya abonado). Negativo = saldo a favor. */
      saldoExigible,
      aPagarAhora: saldoExigible.isNegative() ? cero() : saldoExigible,
      /** Cuotas y cargos de los meses siguientes que ya existen (compras diferidas, recurrentes proyectados). */
      porVencer,
      porVencerTarjetas,
      /** Lo que debe en total: lo exigible ahora + lo que aún no vence. */
      deudaTotal: total,
      estado: saldoExigible.greaterThan(0) ? 'DEBE' : saldoExigible.isNegative() ? 'A_FAVOR' : 'PAZ_Y_SALVO',
      /** Cuotas de meses anteriores sin asiento en el estado de cuenta: no se suman al saldo (puede que ya las haya pagado). */
      historicoSinCargar: { cuotas: historicas.length, monto: suma(historicas.map((c) => c.monto)) },
      tieneActividad: l.tieneActividad || cuotas.some((c) => c.periodo >= periodo) || historicas.length > 0 || !porVencerOtros.isZero(),
      porTarjeta: this.desglosarPorTarjeta(cuotas, periodo, null, conCompras),
    };
  }

  /** Cuotas de tarjeta de la persona agrupadas por tarjeta y por compra (solo lo del mes y lo que viene). */
  private desglosarPorTarjeta(cuotas: CuotaTercero[], periodo: string, coberturas: Map<string, Cobertura> | null, conCompras = true): DesgloseTarjeta[] {
    const vigentes = cuotas.filter((c) => c.periodo >= periodo);
    const porTarjeta = this.agrupar(vigentes, (c) => c.tarjetaId ?? 0n);
    const salida: DesgloseTarjeta[] = [];
    for (const [, filas] of porTarjeta) {
      const compras = [...this.agrupar(filas, (c) => c.compraId)].map(([, cs]) => this.compraDe(cs, periodo, coberturas));
      salida.push({
        tarjetaId: filas[0].tarjetaId === null ? null : Number(filas[0].tarjetaId),
        tarjeta: filas[0].tarjeta,
        totalMes: suma(filas.filter((c) => c.periodo === periodo).map((c) => c.monto)),
        porVencer: suma(filas.filter((c) => c.periodo > periodo).map((c) => c.monto)),
        numeroCompras: compras.length,
        ...(conCompras ? { compras: compras.sort((a, b) => (b.cuotaDelMes ? 1 : 0) - (a.cuotaDelMes ? 1 : 0) || (b.fechaCompra?.getTime() ?? 0) - (a.fechaCompra?.getTime() ?? 0)) } : {}),
      });
    }
    return salida.sort((a, b) => b.totalMes.comparedTo(a.totalMes) || (a.tarjeta ?? '').localeCompare(b.tarjeta ?? ''));
  }

  private compraDe(filas: CuotaTercero[], periodo: string, coberturas: Map<string, Cobertura> | null): CompraDeLaPersona {
    const base = filas[0];
    const delMes = filas.find((c) => c.periodo === periodo);
    const siguientes = filas.filter((c) => c.periodo > periodo);
    const cob = delMes && coberturas ? coberturas.get(`cuota-${delMes.cuotaId}-${delMes.responsableId}`) : undefined;
    return {
      compraId: Number(base.compraId),
      concepto: base.concepto,
      fechaCompra: base.fechaCompra,
      valorCompra: base.valorCompra,
      numeroCuotasCompra: base.numeroCuotasCompra,
      cuotasDeLaPersona: base.cuotasDeLaPersona ?? base.numeroCuotasCompra,
      porcentaje: base.porcentaje,
      plastico: base.plasticoUltimos4,
      cuotaDelMes: delMes
        ? {
            numero: delMes.numeroCuota,
            monto: delMes.monto,
            fechaPago: delMes.fechaPago,
            estado: cob?.estado ?? 'PENDIENTE',
            cubierto: cob?.cubierto ?? cero(),
            pendiente: cob?.pendiente ?? delMes.monto,
          }
        : null,
      restantes: { cuotas: siguientes.length, monto: suma(siguientes.map((c) => c.monto)) },
    };
  }

  /** Cuotas de meses anteriores que SÍ están en el estado de cuenta (asiento firme) y aún no quedaron cubiertas por un abono. */
  private cuotasAnteriores(cuotas: CuotaTercero[], periodo: string, coberturas: Map<string, Cobertura>) {
    return cuotas
      .filter((c) => c.periodo < periodo && c.movimientoEstado === EstadoMovimientoDeuda.CONFIRMADO)
      .map((c) => ({ c, cob: coberturas.get(`cuota-${c.cuotaId}-${c.responsableId}`) }))
      .filter(({ cob }) => cob && cob.estado !== 'PAGADA')
      .map(({ c, cob }) => ({
        compraId: Number(c.compraId),
        concepto: c.concepto,
        tarjeta: c.tarjeta,
        periodo: c.periodo,
        numeroCuota: c.numeroCuota,
        cuotasDeLaCompra: c.numeroCuotasCompra,
        monto: c.monto,
        estado: cob?.estado ?? 'PENDIENTE',
        pendiente: cob?.pendiente ?? c.monto,
      }));
  }

  /** Cargos de meses futuros distintos a cuotas de tarjeta (recurrentes proyectados, etc.), por persona. */
  private async porVencerOtros(ownerUserId: bigint, periodo: string, personaId?: number): Promise<Map<bigint, Decimal>> {
    const grupos = await this.prisma.movimientosDeudaPersona.groupBy({
      by: ['persona_id'],
      where: {
        owner_user_id: ownerUserId,
        periodo_imputacion: { gt: periodo },
        signo: 1,
        tipo_movimiento: { not: TipoMovimientoDeuda.CARGO_CUOTA_TC },
        OR: [{ estado: null }, { estado: { not: EstadoMovimientoDeuda.ANULADO } }],
        ...(personaId !== undefined ? { persona_id: BigInt(personaId) } : {}),
      },
      _sum: { monto: true },
    });
    return new Map(grupos.map((g) => [g.persona_id, money(toDecimal(g._sum.monto))]));
  }

  /** Cargos (no tarjeta ni préstamos) y abonos firmes hasta el periodo, para aplicar los abonos a los cargos más antiguos. */
  private async movimientosParaAplicar(ownerUserId: bigint, personaId: number, periodo: string) {
    const filas = await this.prisma.movimientosDeudaPersona.findMany({
      where: { owner_user_id: ownerUserId, persona_id: BigInt(personaId), periodo_imputacion: { lte: periodo }, estado: EstadoMovimientoDeuda.CONFIRMADO, prestamo_id: null },
      select: { id: true, tipo_movimiento: true, signo: true, monto: true, periodo_imputacion: true, fecha_movimiento: true },
    });
    const cargos: CargoAplicable[] = filas
      .filter((m) => m.signo > 0 && m.tipo_movimiento !== TipoMovimientoDeuda.CARGO_CUOTA_TC)
      .map((m) => ({ clave: `mov-${m.id}`, periodo: m.periodo_imputacion ?? periodo, fecha: m.fecha_movimiento, monto: money(toDecimal(m.monto)) }));
    const totalAbonos = suma(filas.filter((m) => m.signo < 0).map((m) => money(toDecimal(m.monto))));
    return { cargos, totalAbonos };
  }

  private validarPeriodo(p: string | undefined): string {
    const periodo = p ?? periodoActual();
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    return periodo;
  }

  private agrupar<T, K>(lista: T[], clave: (x: T) => K): Map<K, T[]> {
    const m = new Map<K, T[]>();
    for (const x of lista) {
      const k = clave(x);
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  }
}
