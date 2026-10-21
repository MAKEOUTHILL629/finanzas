import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { formatIsoDate, hoyBogota, parseIsoDate, periodoOf } from '../../common/utils/date.util';
import { money, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { resolverPlasticoCompra } from '../tarjetas/plasticos.db';
import { ComprasCreditoService, TX_OPTIONS } from './compras-credito.service';
import { EjecutarBarridoFechaDto, EjecutarRefinanciamientoDto, SimularBarridoFechaDto, SimularRefinanciamientoDto } from './dto/refinanciamiento.dto';
import {
  CompraUnificable,
  ResultadoSimulacion,
  ResponsableDeMaestra,
  responsablesDeLaMaestra,
  resumenBarrido,
  simularRefinanciamiento,
  totalesDeSeleccion,
} from './refinanciamiento.util';

type Tx = Prisma.TransactionClient;

/** Estado con el que quedan las compras (y sus cuotas pendientes) absorbidas por un refinanciamiento. */
export const ESTADO_REFINANCIADA = 'REFINANCIADA';

interface FilaCandidata {
  id: bigint;
  concepto: string | null;
  fecha_compra: Date | null;
  numero_cuotas: number | null;
  valor_compra: Prisma.Decimal | null;
  interes: Prisma.Decimal | null;
  es_refinanciamiento: boolean;
  plastico: string | null;
  saldo_capital: Prisma.Decimal | null;
  restante: Prisma.Decimal | null;
  cuotas_pendientes: number;
  cuota_proxima: Prisma.Decimal | null;
  proximo_periodo: string | null;
}

/** Una compra pendiente que se podría unificar. */
export interface CandidataRefinanciamiento {
  id: number;
  concepto: string | null;
  fechaCompra: string | null;
  valorCompra: number;
  numeroCuotas: number;
  interes: number;
  plasticoUltimos4: string | null;
  /** La compra ya es una unificación anterior (se puede volver a refinanciar). */
  esRefinanciamiento: boolean;
  cuotasPendientes: number;
  saldoCapital: number;
  restantePorPagar: number;
  cuotaProxima: number;
  proximoPeriodo: string | null;
  responsables: Array<{ personaId: number; porcentaje: number }>;
}

export interface SimulacionRefinanciamiento {
  tarjetaId: number;
  compraIds: number[];
  /** Cuánto pagas hoy cada mes con esas compras. */
  cuotaActualCombinada: number;
  resultado: ResultadoSimulacion;
  /** Cómo se repartiría la nueva obligación entre las personas. */
  responsables: ResponsableDeMaestra[];
}

export interface SimulacionBarridoFecha {
  tarjetaIds: number[];
  fechaCorte: string;
  /** Compras detectadas automáticamente: vigentes al corte en las tarjetas indicadas. */
  comprasDetectadas: CandidataRefinanciamiento[];
  cantidadCompras: number;
  /** Suma de saldos de capital en BD de las compras detectadas. */
  capitalTeoricoDetectado: number;
  /** Valor exacto que fijó el banco ($X). */
  montoUnificadoBanco: number;
  /** X − capital teórico (puede ser negativo si el banco fijó menos). */
  ajusteDiferencia: number;
  cuotaActualCombinada: number;
  resultado: ResultadoSimulacion;
  responsables: ResponsableDeMaestra[];
}

export interface DetalleRefinanciamiento {
  id: number;
  concepto: string | null;
  /** Sí = esta compra ES la obligación nueva; no = es una compra absorbida por `maestraId`. */
  esMaestra: boolean;
  maestraId: number | null;
  fechaCompra: string | null;
  saldoUnificado: number;
  numeroCuotas: number;
  tasaMensual: number;
  cuotaMensual: number;
  cuotaPactada: number | null;
  sistemaAmortizacion: string;
  /** SELECCION_MANUAL | BARRIDO_FECHA_CORTE (sql/017). */
  modoUnificacion: string;
  fechaCorteUnificacion: string | null;
  capitalTeoricoAbsorbido: number | null;
  ajusteBancoCapitalizado: number | null;
  tarjetaId: number | null;
  absorbidas: Array<{
    id: number;
    concepto: string | null;
    fechaCompra: string | null;
    valorCompra: number;
    numeroCuotas: number;
    estado: string | null;
    saldoRefinanciado: number;
    esRefinanciamiento: boolean;
  }>;
}

const num = (v: Prisma.Decimal | Decimal | null | undefined): number => (v === null || v === undefined ? 0 : Number(v.toString()));
const dia = (d: Date | null | undefined): string | null => (d ? formatIsoDate(d) : null);

/**
 * Refinanciamiento / unificación de deuda de una tarjeta de crédito (plan V2, fase 5).
 *
 * El banco ofrece «rediferir» lo que se debe a N meses con otra tasa. Aquí se simula con los datos que da el asesor y, al
 * confirmar, UNA transacción: crea la obligación nueva (cuota fija, tabla francesa) con las personas responsables que ya tenían
 * las compras, marca las originales como `REFINANCIADA` (sus cuotas pendientes dejan de cobrarse, pero siguen vinculadas) y
 * anula los cargos futuros que esas cuotas tenían en el sub-ledger de las personas. `deshacer` lo revierte todo.
 */
@Injectable()
export class RefinanciamientoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compras: ComprasCreditoService,
  ) {}

  // ───────────────────────────── lectura ─────────────────────────────

  /** Compras pendientes de la tarjeta con su saldo de capital (cuotas pendientes del periodo en curso en adelante). */
  async candidatas(ownerUserId: bigint, tarjetaId: number, ahora: Date = new Date()): Promise<CandidataRefinanciamiento[]> {
    await this.exigirTarjetaDeCredito(this.prisma, ownerUserId, tarjetaId);
    return this.cargarCandidatas(this.prisma, ownerUserId, tarjetaId, undefined, periodoOf(hoyBogota(ahora)));
  }

  async simular(ownerUserId: bigint, dto: SimularRefinanciamientoDto, ahora: Date = new Date()): Promise<SimulacionRefinanciamiento> {
    const tarjeta = await this.exigirTarjetaDeCredito(this.prisma, ownerUserId, dto.tarjetaId);
    const seleccion = await this.seleccionar(this.prisma, ownerUserId, dto, ahora);
    return this.armarSimulacion(dto, tarjeta.dia_corte, seleccion, ahora);
  }

  // ───────────────────────────── barrido por fecha de corte ─────────────────────────────

  /** Simula el barrido: detecta las compras vigentes al corte y compara su capital teórico contra el valor $X del banco. */
  async simularBarridoFecha(ownerUserId: bigint, dto: SimularBarridoFechaDto): Promise<SimulacionBarridoFecha> {
    const fechaCorte = this.fechaCorteDe(dto);
    const tarjetas = await this.exigirTarjetasDeCredito(this.prisma, ownerUserId, dto.tarjetaIds);
    const detectadas = await this.cargarDetectadasBarrido(this.prisma, ownerUserId, dto.tarjetaIds, fechaCorte);
    return this.armarSimulacionBarrido(dto, tarjetas[0].dia_corte, detectadas, fechaCorte);
  }

  /** Ejecuta el barrido en una sola transacción: crea la maestra por $X y congela las cuotas posteriores al corte. */
  async ejecutarBarridoFecha(ownerUserId: bigint, dto: EjecutarBarridoFechaDto): Promise<DetalleRefinanciamiento & { simulacion: SimulacionBarridoFecha }> {
    const { maestraId, simulacion } = await this.prisma.$transaction(async (tx) => {
      const fechaCorte = this.fechaCorteDe(dto);
      const tarjetas = await this.exigirTarjetasDeCredito(tx, ownerUserId, dto.tarjetaIds);
      const tarjetaPrincipal = tarjetas[0];
      const detectadas = await this.cargarDetectadasBarrido(tx, ownerUserId, dto.tarjetaIds, fechaCorte);
      const simulacion = this.armarSimulacionBarrido(dto, tarjetaPrincipal.dia_corte, detectadas, fechaCorte);
      const r = simulacion.resultado;
      const periodoCorte = periodoOf(fechaCorte);

      const etiqueta = [tarjetaPrincipal.franquicia, tarjetaPrincipal.descripcion].filter(Boolean).join(' ') || `tarjeta ${dto.tarjetaIds[0]}`;
      const concepto = (dto.concepto ?? `Unificación / Refinanciamiento ${etiqueta} (Corte ${formatIsoDate(fechaCorte)})`).slice(0, 255);
      const plasticoId = await resolverPlasticoCompra(tx, ownerUserId, tarjetaPrincipal.id, { fecha: fechaCorte });

      const maestra = await tx.comprasCredito.create({
        data: {
          concepto,
          valor_compra: toDbMoney(r.saldo),
          fecha_compra: fechaCorte,
          numero_cuotas: r.numeroCuotas,
          fecha_ultima_cuota: r.cuotas[r.cuotas.length - 1].fechaPago,
          pago_mensual: toDbMoney(r.cuotaUsada),
          interes: toDbRate(r.tasaMensualPct),
          descripcion: dto.descripcion ?? `Barrido al ${formatIsoDate(fechaCorte)}: ${detectadas.length} compras, capital teórico $${simulacion.capitalTeoricoDetectado}, ajuste del banco $${simulacion.ajusteDiferencia}`,
          estado: 'Pendiente',
          tarjeta: tarjetaPrincipal.id,
          owner_user_id: ownerUserId,
          plastico_id: plasticoId,
          moneda_original: 'COP',
          valor_moneda_original: toDbMoney(r.saldo),
          tasa_cambio_aplicada: toDbRate(new Decimal(1)),
          trm_confirmada: true,
          es_refinanciamiento: true,
          sistema_amortizacion: 'FRANCES',
          cuota_fija_pactada: r.cuotaPactada ? toDbMoney(r.cuotaPactada) : null,
          modo_unificacion: 'BARRIDO_FECHA_CORTE',
          fecha_corte_unificacion: fechaCorte,
          capital_teorico_absorbido: toDbMoney(toDecimal(simulacion.capitalTeoricoDetectado)),
          ajuste_banco_capitalizado: toDbMoney(toDecimal(simulacion.ajusteDiferencia)),
        },
      });
      await tx.cuotasDetalle.createMany({ data: this.compras.cuotasData(maestra.id, r.cuotas) });

      // Después de las cuotas: el Trigger 6 genera los cargos de cada persona al insertar su responsabilidad.
      for (const p of simulacion.responsables) {
        await tx.responsablesComprasCredito.create({
          data: {
            persona: BigInt(p.personaId),
            porcentaje_pago: toDbMoney(p.porcentaje),
            cantidad_pago: toDbMoney(p.monto),
            cantidad_cuotas: r.numeroCuotas,
            compra_credito: maestra.id,
          },
        });
      }

      const ids = detectadas.map((c) => BigInt(c.id));
      for (const c of detectadas) {
        await tx.comprasCredito.update({
          where: { id: BigInt(c.id) },
          data: { estado: ESTADO_REFINANCIADA, refinanciamiento_id: maestra.id, saldo_refinanciado: toDbMoney(toDecimal(c.saldoCapital)) },
        });
      }
      if (ids.length > 0) {
        await tx.$executeRaw`
          UPDATE "CuotasDetalle" cd SET estado = ${ESTADO_REFINANCIADA}
          WHERE cd.compra = ANY(${ids}::int8[])
            AND UPPER(COALESCE(cd.estado, '')) = 'PENDIENTE'
            AND COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) > ${periodoCorte}`;
        await tx.$executeRaw`
          UPDATE "MovimientosDeudaPersona" m SET estado = 'ANULADO'
          FROM "CuotasDetalle" cd
          WHERE m.cuota_detalle_id = cd.id
            AND cd.compra = ANY(${ids}::int8[])
            AND cd.estado = ${ESTADO_REFINANCIADA}
            AND m.tipo_movimiento = 'CARGO_CUOTA_TC'
            AND COALESCE(m.estado, 'CONFIRMADO') IN ('PROYECTADO', 'CONFIRMADO')`;
      }
      return { maestraId: maestra.id, simulacion };
    }, TX_OPTIONS);

    return { ...(await this.detalle(ownerUserId, Number(maestraId))), simulacion };
  }

  private fechaCorteDe(dto: SimularBarridoFechaDto): Date {
    const f = parseIsoDate(dto.fechaCorte);
    if (!f) throw datosInvalidos({ fechaCorte: ['La fecha de corte no es válida'] });
    return f;
  }

  private async exigirTarjetasDeCredito(db: Tx | PrismaService, ownerUserId: bigint, tarjetaIds: number[]) {
    const tarjetas = [];
    for (const id of [...new Set(tarjetaIds)]) tarjetas.push(await this.exigirTarjetaDeCredito(db, ownerUserId, id));
    return tarjetas;
  }

  private async cargarDetectadasBarrido(db: Tx | PrismaService, ownerUserId: bigint, tarjetaIds: number[], fechaCorte: Date): Promise<CandidataRefinanciamiento[]> {
    const todas: CandidataRefinanciamiento[] = [];
    for (const tarjetaId of [...new Set(tarjetaIds)]) {
      todas.push(...(await this.cargarCandidatas(db, ownerUserId, tarjetaId, undefined, periodoOf(fechaCorte), { periodoExclusivo: true, fechaCompraHasta: fechaCorte })));
    }
    return todas.sort((a, b) => (a.fechaCompra ?? '').localeCompare(b.fechaCompra ?? '') || a.id - b.id);
  }

  private armarSimulacionBarrido(dto: SimularBarridoFechaDto, diaCorte: number | null, detectadas: CandidataRefinanciamiento[], fechaCorte: Date): SimulacionBarridoFecha {
    if (detectadas.length === 0) {
      throw datosInvalidos({ fechaCorte: [`Ninguna compra vigente al ${formatIsoDate(fechaCorte)} en las tarjetas indicadas`] });
    }
    const unificables = detectadas.map(aUnificable);
    const resumen = resumenBarrido(unificables, toDecimal(dto.montoUnificadoBanco));
    const totales = totalesDeSeleccion(unificables);
    const resultado = simularRefinanciamiento({
      saldo: resumen.montoUnificadoBanco,
      numeroCuotas: dto.numeroCuotas,
      tasaMensualPct: dto.tasaMensual === undefined ? null : toDecimal(dto.tasaMensual),
      tasaEfectivaAnualPct: dto.tasaEfectivaAnual === undefined ? null : toDecimal(dto.tasaEfectivaAnual),
      cuotaPactada: dto.cuotaMensual === undefined ? null : toDecimal(dto.cuotaMensual),
      cuotaActualCombinada: totales.cuotaActualCombinada,
      restantePorPagar: totales.restantePorPagar,
      fechaInicio: fechaCorte,
      diaCorteTarjeta: diaCorte,
      hoy: fechaCorte,
    });
    return {
      tarjetaIds: [...new Set(dto.tarjetaIds)],
      fechaCorte: formatIsoDate(fechaCorte),
      comprasDetectadas: detectadas,
      cantidadCompras: resumen.cantidadCompras,
      capitalTeoricoDetectado: resumen.capitalTeorico.toNumber(),
      montoUnificadoBanco: resumen.montoUnificadoBanco.toNumber(),
      ajusteDiferencia: resumen.ajusteBanco.toNumber(),
      cuotaActualCombinada: totales.cuotaActualCombinada.toNumber(),
      resultado,
      // Cada persona conserva su parte teórica; el ajuste del banco lo absorbe el titular.
      responsables: responsablesDeLaMaestra(unificables, resumen.montoUnificadoBanco),
    };
  }

  /** Para una compra maestra: las que unificó. Para una absorbida: la maestra (con todo lo que unificó). `null` si no aplica. */
  async detalle(ownerUserId: bigint, compraId: number): Promise<DetalleRefinanciamiento> {
    const compra = await this.prisma.comprasCredito.findFirst({ where: { id: BigInt(compraId), owner_user_id: ownerUserId } });
    if (!compra) throw new NotFoundException(`Compra ${compraId} no encontrada`);
    const maestraId = compra.es_refinanciamiento ? compra.id : compra.refinanciamiento_id;
    if (maestraId === null) throw new NotFoundException(`La compra ${compraId} no forma parte de un refinanciamiento`);
    const maestra = maestraId === compra.id ? compra : await this.prisma.comprasCredito.findFirstOrThrow({ where: { id: maestraId, owner_user_id: ownerUserId } });
    const absorbidas = await this.prisma.comprasCredito.findMany({
      where: { refinanciamiento_id: maestra.id, owner_user_id: ownerUserId },
      orderBy: [{ fecha_compra: 'asc' }, { id: 'asc' }],
    });
    return {
      id: Number(maestra.id),
      concepto: maestra.concepto,
      esMaestra: compra.id === maestra.id,
      maestraId: Number(maestra.id),
      fechaCompra: dia(maestra.fecha_compra),
      saldoUnificado: num(maestra.valor_compra),
      numeroCuotas: maestra.numero_cuotas ?? 0,
      tasaMensual: num(maestra.interes),
      cuotaMensual: num(maestra.cuota_fija_pactada ?? maestra.pago_mensual),
      cuotaPactada: maestra.cuota_fija_pactada === null ? null : num(maestra.cuota_fija_pactada),
      sistemaAmortizacion: maestra.sistema_amortizacion,
      modoUnificacion: maestra.modo_unificacion ?? 'SELECCION_MANUAL',
      fechaCorteUnificacion: dia(maestra.fecha_corte_unificacion),
      capitalTeoricoAbsorbido: maestra.capital_teorico_absorbido === null ? null : num(maestra.capital_teorico_absorbido),
      ajusteBancoCapitalizado: maestra.ajuste_banco_capitalizado === null ? null : num(maestra.ajuste_banco_capitalizado),
      tarjetaId: maestra.tarjeta === null ? null : Number(maestra.tarjeta),
      absorbidas: absorbidas.map((a) => ({
        id: Number(a.id),
        concepto: a.concepto,
        fechaCompra: dia(a.fecha_compra),
        valorCompra: num(a.valor_compra),
        numeroCuotas: a.numero_cuotas ?? 0,
        estado: a.estado,
        saldoRefinanciado: num(a.saldo_refinanciado),
        esRefinanciamiento: a.es_refinanciamiento,
      })),
    };
  }

  // ───────────────────────────── ejecución ─────────────────────────────

  async ejecutar(ownerUserId: bigint, dto: EjecutarRefinanciamientoDto, ahora: Date = new Date()): Promise<DetalleRefinanciamiento & { simulacion: SimulacionRefinanciamiento }> {
    const { maestraId, simulacion } = await this.prisma.$transaction(async (tx) => {
      const tarjeta = await this.exigirTarjetaDeCredito(tx, ownerUserId, dto.tarjetaId);
      const seleccion = await this.seleccionar(tx, ownerUserId, dto, ahora);
      const simulacion = this.armarSimulacion(dto, tarjeta.dia_corte, seleccion, ahora);
      const r = simulacion.resultado;
      const fecha = this.fechaDe(dto, ahora);
      const periodoActual = periodoOf(hoyBogota(ahora));

      const etiqueta = [tarjeta.franquicia, tarjeta.descripcion].filter(Boolean).join(' ') || `tarjeta ${dto.tarjetaId}`;
      const concepto = (dto.concepto ?? `Refinanciamiento ${etiqueta} ${formatIsoDate(fecha)}`).slice(0, 255);
      const plasticoId = await resolverPlasticoCompra(tx, ownerUserId, tarjeta.id, { fecha });

      const maestra = await tx.comprasCredito.create({
        data: {
          concepto,
          valor_compra: toDbMoney(r.saldo),
          fecha_compra: fecha,
          numero_cuotas: r.numeroCuotas,
          fecha_ultima_cuota: r.cuotas[r.cuotas.length - 1].fechaPago,
          pago_mensual: toDbMoney(r.cuotaUsada),
          interes: toDbRate(r.tasaMensualPct),
          descripcion: dto.descripcion ?? `Unifica ${seleccion.length} compra${seleccion.length === 1 ? '' : 's'} con un saldo de capital de $${r.saldo.toString()}`,
          estado: 'Pendiente',
          tarjeta: tarjeta.id,
          owner_user_id: ownerUserId,
          plastico_id: plasticoId,
          moneda_original: 'COP',
          valor_moneda_original: toDbMoney(r.saldo),
          tasa_cambio_aplicada: toDbRate(new Decimal(1)),
          trm_confirmada: true,
          es_refinanciamiento: true,
          sistema_amortizacion: 'FRANCES',
          cuota_fija_pactada: r.cuotaPactada ? toDbMoney(r.cuotaPactada) : null,
        },
      });
      await tx.cuotasDetalle.createMany({ data: this.compras.cuotasData(maestra.id, r.cuotas) });

      // Después de las cuotas: el Trigger 6 genera los cargos de cada persona al insertar su responsabilidad.
      for (const p of simulacion.responsables) {
        await tx.responsablesComprasCredito.create({
          data: {
            persona: BigInt(p.personaId),
            porcentaje_pago: toDbMoney(p.porcentaje),
            cantidad_pago: toDbMoney(p.monto),
            cantidad_cuotas: r.numeroCuotas,
            compra_credito: maestra.id,
          },
        });
      }

      // Las originales dejan de cobrarse por separado, sin perder la trazabilidad.
      const ids = seleccion.map((c) => BigInt(c.id));
      for (const c of seleccion) {
        await tx.comprasCredito.update({
          where: { id: BigInt(c.id) },
          data: { estado: ESTADO_REFINANCIADA, refinanciamiento_id: maestra.id, saldo_refinanciado: toDbMoney(toDecimal(c.saldoCapital)) },
        });
      }
      await tx.$executeRaw`
        UPDATE "CuotasDetalle" cd SET estado = ${ESTADO_REFINANCIADA}
        WHERE cd.compra = ANY(${ids}::int8[])
          AND UPPER(COALESCE(cd.estado, '')) = 'PENDIENTE'
          AND COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) >= ${periodoActual}`;
      // Lo que las personas debían por esas cuotas pasa a deberse por la obligación nueva: se anulan los cargos viejos.
      await tx.$executeRaw`
        UPDATE "MovimientosDeudaPersona" m SET estado = 'ANULADO'
        FROM "CuotasDetalle" cd
        WHERE m.cuota_detalle_id = cd.id
          AND cd.compra = ANY(${ids}::int8[])
          AND cd.estado = ${ESTADO_REFINANCIADA}
          AND m.tipo_movimiento = 'CARGO_CUOTA_TC'
          AND COALESCE(m.estado, 'CONFIRMADO') IN ('PROYECTADO', 'CONFIRMADO')`;
      return { maestraId: maestra.id, simulacion };
    }, TX_OPTIONS);

    return { ...(await this.detalle(ownerUserId, Number(maestraId))), simulacion };
  }

  /**
   * Deshace un refinanciamiento: las compras originales vuelven a cobrarse como antes (con sus cargos a las personas) y se borra la
   * obligación nueva. Solo mientras la nueva no tenga cuotas pagadas.
   */
  async deshacer(ownerUserId: bigint, maestraId: number, ahora: Date = new Date()): Promise<{ restauradas: number }> {
    return this.prisma.$transaction(async (tx) => {
      const maestra = await tx.comprasCredito.findFirst({ where: { id: BigInt(maestraId), owner_user_id: ownerUserId } });
      if (!maestra || !maestra.es_refinanciamiento) throw new NotFoundException(`El refinanciamiento ${maestraId} no existe`);
      if (maestra.sistema_amortizacion !== 'FRANCES') {
        // los refinanciamientos históricos (vinculados con scripts/vincular-refinanciamientos-historicos.js) conservan su estado «Ajuste Interes»
        throw new HttpException({ message: 'Este refinanciamiento se registró a mano antes de la unificación automática: no se puede deshacer desde la app' }, HttpStatus.CONFLICT);
      }
      const pagadas = await tx.cuotasDetalle.count({ where: { compra: maestra.id, estado: { in: ['Pagado', 'PAGADO', 'Pagada', 'PAGADA', 'FACTURADA'] } } });
      if (pagadas > 0) {
        throw new HttpException({ message: `El refinanciamiento ya tiene ${pagadas} cuota${pagadas === 1 ? '' : 's'} pagada${pagadas === 1 ? '' : 's'}: no se puede deshacer` }, HttpStatus.CONFLICT);
      }
      const periodoActual = periodoOf(hoyBogota(ahora));
      const absorbidas = await tx.comprasCredito.findMany({ where: { refinanciamiento_id: maestra.id, owner_user_id: ownerUserId }, select: { id: true } });
      const ids = absorbidas.map((a) => a.id);

      if (ids.length > 0) {
        await tx.comprasCredito.updateMany({ where: { id: { in: ids } }, data: { estado: 'Pendiente', refinanciamiento_id: null, saldo_refinanciado: null } });
        await tx.$executeRaw`
          UPDATE "CuotasDetalle" SET estado = 'Pendiente'
          WHERE compra = ANY(${ids}::int8[]) AND estado = ${ESTADO_REFINANCIADA}`;
        // los cargos que se anularon al unificar vuelven (confirmados si ya tocaba cobrarlos, proyectados si no)
        await tx.$executeRaw`
          UPDATE "MovimientosDeudaPersona" m
          SET estado = CASE WHEN cd.numero_cuota = 1 OR COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) <= ${periodoActual} THEN 'CONFIRMADO' ELSE 'PROYECTADO' END
          FROM "CuotasDetalle" cd
          WHERE m.cuota_detalle_id = cd.id
            AND cd.compra = ANY(${ids}::int8[])
            AND m.tipo_movimiento = 'CARGO_CUOTA_TC'
            AND m.estado = 'ANULADO'`;
      }
      await this.compras.deleteTx(tx, Number(maestra.id), ownerUserId, { desdeDeshacer: true });
      return { restauradas: ids.length };
    }, TX_OPTIONS);
  }

  // ───────────────────────────── interno ─────────────────────────────

  private fechaDe(dto: SimularRefinanciamientoDto, ahora: Date): Date {
    if (dto.fecha === undefined) return hoyBogota(ahora);
    const f = parseIsoDate(dto.fecha);
    if (!f) throw datosInvalidos({ fecha: ['La fecha no es válida'] });
    return f;
  }

  private async exigirTarjetaDeCredito(db: Tx | PrismaService, ownerUserId: bigint, tarjetaId: number) {
    const tarjeta = await db.tarjetas.findFirst({
      where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId },
      select: { id: true, dia_corte: true, tipo_tarjeta: true, franquicia: true, descripcion: true },
    });
    if (!tarjeta) throw new NotFoundException(`Tarjeta ${tarjetaId} no encontrada`);
    if (tarjeta.tipo_tarjeta === 'DEBITO') throw datosInvalidos({ tarjetaId: ['Solo se unifica la deuda de tarjetas de crédito'] });
    return tarjeta;
  }

  /** Las compras elegidas, validadas: todas pendientes, de esa tarjeta, sin haber sido absorbidas y con saldo. */
  private async seleccionar(db: Tx | PrismaService, ownerUserId: bigint, dto: SimularRefinanciamientoDto, ahora: Date): Promise<CandidataRefinanciamiento[]> {
    const ids = [...new Set(dto.compraIds)];
    const candidatas = await this.cargarCandidatas(db, ownerUserId, dto.tarjetaId, ids, periodoOf(hoyBogota(ahora)));
    const validas = new Set(candidatas.map((c) => c.id));
    const invalidas = ids.filter((id) => !validas.has(id));
    if (invalidas.length > 0) {
      throw datosInvalidos({
        compraIds: [`Las compras ${invalidas.join(', ')} no se pueden unificar: deben ser de esa tarjeta, estar pendientes, con saldo y no haber sido unificadas ya`],
      });
    }
    return candidatas;
  }

  private armarSimulacion(dto: SimularRefinanciamientoDto, diaCorte: number | null, seleccion: CandidataRefinanciamiento[], ahora: Date): SimulacionRefinanciamiento {
    const unificables = seleccion.map(aUnificable);
    const totales = totalesDeSeleccion(unificables);
    const resultado = simularRefinanciamiento({
      saldo: totales.saldo,
      numeroCuotas: dto.numeroCuotas,
      tasaMensualPct: dto.tasaMensual === undefined ? null : toDecimal(dto.tasaMensual),
      tasaEfectivaAnualPct: dto.tasaEfectivaAnual === undefined ? null : toDecimal(dto.tasaEfectivaAnual),
      cuotaPactada: dto.cuotaMensual === undefined ? null : toDecimal(dto.cuotaMensual),
      cuotaActualCombinada: totales.cuotaActualCombinada,
      restantePorPagar: totales.restantePorPagar,
      fechaInicio: this.fechaDe(dto, ahora),
      diaCorteTarjeta: diaCorte,
      hoy: hoyBogota(ahora),
    });
    return {
      tarjetaId: dto.tarjetaId,
      compraIds: seleccion.map((c) => c.id),
      cuotaActualCombinada: totales.cuotaActualCombinada.toNumber(),
      resultado,
      responsables: responsablesDeLaMaestra(unificables, totales.saldo),
    };
  }

  private async cargarCandidatas(
    db: Tx | PrismaService,
    ownerUserId: bigint,
    tarjetaId: number,
    ids: number[] | undefined,
    periodo: string,
    opciones: { periodoExclusivo?: boolean; fechaCompraHasta?: Date } = {},
  ): Promise<CandidataRefinanciamiento[]> {
    const filtroIds = ids ? Prisma.sql`AND cc.id = ANY(${ids.map((i) => BigInt(i))}::int8[])` : Prisma.empty;
    const filtroPeriodo = opciones.periodoExclusivo
      ? Prisma.sql`AND COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) > ${periodo}`
      : Prisma.sql`AND COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) >= ${periodo}`;
    const filtroFechaCompra = opciones.fechaCompraHasta ? Prisma.sql`AND cc.fecha_compra <= ${opciones.fechaCompraHasta}::date` : Prisma.empty;
    const filas = await db.$queryRaw<FilaCandidata[]>(Prisma.sql`
      SELECT cc.id, cc.concepto, cc.fecha_compra, cc.numero_cuotas, cc.valor_compra, cc.interes, cc.es_refinanciamiento, pl.ultimos_4 AS plastico,
             COALESCE(SUM(cd.aporte_capital), 0) AS saldo_capital,
             COALESCE(SUM(cd.pago_total), 0) AS restante,
             COUNT(cd.id)::int AS cuotas_pendientes,
             (ARRAY_AGG(cd.pago_total ORDER BY COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')), cd.numero_cuota))[1] AS cuota_proxima,
             MIN(COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM'))) AS proximo_periodo
      FROM "ComprasCredito" cc
      JOIN "CuotasDetalle" cd ON cd.compra = cc.id
        AND UPPER(COALESCE(cd.estado, '')) = 'PENDIENTE'
        ${filtroPeriodo}
      LEFT JOIN "TarjetaPlasticos" pl ON pl.id = cc.plastico_id
      WHERE cc.owner_user_id = ${ownerUserId}::int8
        AND cc.tarjeta = ${BigInt(tarjetaId)}::int8
        AND cc.refinanciamiento_id IS NULL
        AND UPPER(COALESCE(cc.estado, '')) = 'PENDIENTE'
        ${filtroFechaCompra}
        ${filtroIds}
      GROUP BY cc.id, pl.ultimos_4
      HAVING COALESCE(SUM(cd.aporte_capital), 0) > 0
      ORDER BY cc.fecha_compra DESC NULLS LAST, cc.id DESC`);
    if (filas.length === 0) return [];

    const responsables = await db.responsablesComprasCredito.findMany({
      where: { compra_credito: { in: filas.map((f) => f.id) }, persona: { not: null } },
      select: { compra_credito: true, persona: true, porcentaje_pago: true },
      orderBy: { id: 'asc' },
    });
    const porCompra = new Map<string, Array<{ personaId: number; porcentaje: number }>>();
    for (const r of responsables) {
      const clave = String(r.compra_credito);
      porCompra.set(clave, [...(porCompra.get(clave) ?? []), { personaId: Number(r.persona), porcentaje: num(r.porcentaje_pago) }]);
    }
    return filas.map((f) => ({
      id: Number(f.id),
      concepto: f.concepto,
      fechaCompra: dia(f.fecha_compra),
      valorCompra: num(f.valor_compra),
      numeroCuotas: f.numero_cuotas ?? 0,
      interes: num(f.interes),
      plasticoUltimos4: f.plastico,
      esRefinanciamiento: f.es_refinanciamiento,
      cuotasPendientes: f.cuotas_pendientes,
      saldoCapital: money(toDecimal(f.saldo_capital)).toNumber(),
      restantePorPagar: money(toDecimal(f.restante)).toNumber(),
      cuotaProxima: money(toDecimal(f.cuota_proxima)).toNumber(),
      proximoPeriodo: f.proximo_periodo,
      responsables: porCompra.get(String(f.id)) ?? [],
    }));
  }
}

function aUnificable(c: CandidataRefinanciamiento): CompraUnificable {
  return {
    id: c.id,
    saldoCapital: toDecimal(c.saldoCapital),
    restantePorPagar: toDecimal(c.restantePorPagar),
    cuotaProxima: toDecimal(c.cuotaProxima),
    responsables: c.responsables.map((r) => ({ personaId: r.personaId, porcentaje: toDecimal(r.porcentaje) })),
  };
}

