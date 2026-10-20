import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidPeriodo, periodoActual, todayLocal } from '../../common/utils/date.util';
import { money, toDecimal } from '../../common/utils/decimal.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
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
