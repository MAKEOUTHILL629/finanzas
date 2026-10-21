import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DestinoExcedente,
  EstadoMovimientoDeuda,
  EstadoPrestamo,
  EstadoTransaccion,
  OrigenRegistro,
  TipoMovimientoDeuda,
  TipoObligacionMes,
  TipoTransaccion,
} from '../../common/enums/finance.enums';
import { isValidPeriodo, parseIsoDate, periodoActual, periodoOf, todayLocal } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCuenta, assertObligacion, assertPersona } from '../../common/utils/ownership.util';
import { addMesesPeriodo, nombrePeriodo, primerDiaPeriodo, ultimoDiaPeriodo } from '../../common/utils/periodo.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { calcularEstadoPeriodo, clasificarMetodo, MetodoCanonico, resumenMediosPago } from './aportes-carro.calc';
import { normalizarTags } from '../notificaciones-correo/comercio.util';
import {
  ActualizarAporteDiarioDto,
  AplicarExcedenteDto,
  CrearAporteDiarioDto,
  DetalleAporteDiarioDto,
  GuardarPeriodoDto,
} from './dto/aportes-carro.dto';

type Tx = Prisma.TransactionClient;

/** Misma persona que identifica el Trigger 3: la tuya (`linked_user_id`) o la migrada de AppSheet. */
const LEGACY_PERSONA_YO = 'lm1R40P16oHgkM3Szu91du';
/** Los aportes con varias líneas hacen varias consultas dentro de la transacción. */
const TX_OPCIONES = { timeout: 30_000, maxWait: 10_000 };

const PERSONA_SELECT = { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } as const;
const INCLUDE_DETALLE = { persona: { select: PERSONA_SELECT }, cuenta: { select: { id: true, nombre: true } } } as const;
const INCLUDE_PERIODO = {
  responsable_principal: { select: PERSONA_SELECT },
  dias: {
    include: { detalles: { include: INCLUDE_DETALLE, orderBy: { id: 'asc' } } },
    orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
  },
} satisfies Prisma.ObligacionesMesInclude;

type Detalle = Prisma.AportesDetalleGetPayload<{ include: typeof INCLUDE_DETALLE }>;
type Periodo = Prisma.ObligacionesMesGetPayload<{ include: typeof INCLUDE_PERIODO }>;
type Dia = Periodo['dias'][number];

interface ContextoDia {
  dia: { id: bigint };
  obligacion: { id: bigint; periodo: string; concepto: string; tipo_obligacion: string; responsable_principal_id: bigint };
  fecha: Date;
  miPersonaId: bigint | null;
}

const num = (v: bigint | null): number | null => (v === null ? null : Number(v));
const sumar = (valores: Array<{ valor: Prisma.Decimal | Decimal }>): Decimal =>
  money(valores.reduce((acc, v) => acc.plus(toDecimal(v.valor)), new Decimal(0)));
const igual = (a: Prisma.Decimal | Decimal, b: Prisma.Decimal | Decimal): boolean => toDecimal(a).equals(toDecimal(b));
const nombreDe = (p: { nombre: string | null }): string => p.nombre ?? 'la persona';

/**
 * Aportes diarios de la cuota del carro (y de cualquier obligación mensual): periodos con cuota objetivo, aportes
 * con desglose por método, cruces de cuentas con terceros y saldo a favor (excedente).
 *
 * Reparto de responsabilidades con la BD:
 *   - Un detalle a nombre de un TERCERO lo convierte el Trigger 3 en un Préstamo POR_COBRAR (+ 2 aprobaciones) y el
 *     Trigger 4 lo carga en el sub-ledger de esa persona: eso ES el «cruce de cuentas». Este servicio no lo duplica.
 *   - EFECTIVO/TRANSFERENCIA con cuenta generan un INGRESO confirmado; el Trigger 2 mueve el saldo de la cuenta.
 *   - Editar o borrar un aporte revierte todo lo anterior: anula el préstamo del cruce (el Trigger 4 anula sus asientos),
 *     anula la transacción (el Trigger 2 revierte el saldo) y devuelve el saldo a favor al periodo de origen.
 *   - El monto abonado, el pendiente y el saldo a favor se CALCULAN (no se almacenan) para que no se desfasen; solo
 *     se guarda `ObligacionesMes.saldo_a_favor_aplicado`.
 */
@Injectable()
export class AportesCarroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transacciones: TransaccionesService,
  ) {}

  // ───────────────────────────── Lectura ─────────────────────────────

  /** `GET /carro/resumen`: KPIs, saldo a favor global y periodos (del más reciente al más antiguo) con sus aportes. */
  async resumenCarro(ownerUserId: bigint, opciones: { tipo?: string; periodo?: string } = {}) {
    const tipo = opciones.tipo ?? TipoObligacionMes.CUOTA_CARRO;
    const periodos = await this.prisma.obligacionesMes.findMany({
      where: { owner_user_id: ownerUserId, tipo_obligacion: tipo },
      include: INCLUDE_PERIODO,
      orderBy: [{ periodo: 'desc' }, { id: 'desc' }],
    });

    const vistas = periodos.map((p) => this.vistaPeriodo(p, true));
    const ahora = periodoActual();
    const elegido =
      (opciones.periodo ? vistas.find((v) => v.periodo === opciones.periodo) : undefined) ??
      vistas.find((v) => v.periodo === ahora) ??
      vistas[0] ??
      null;
    const saldoGlobal = money(vistas.reduce((acc, v) => acc.plus(v.saldoAFavorDisponible), new Decimal(0)));

    return {
      tipoObligacion: tipo,
      responsable: periodos[0] ? this.vistaPersona(periodos[0].responsable_principal) : null,
      cuotaBase: periodos[0] ? money(toDecimal(periodos[0].meta_mensual)) : null,
      periodoActual: ahora,
      periodoSeleccionadoId: elegido ? elegido.id : null,
      saldoAFavorDisponibleGlobal: saldoGlobal,
      periodos: vistas,
    };
  }

  /**
   * Datos listos para el mensaje de WhatsApp a Papá (Fase 7): último aporte del periodo elegido
   * y consolidado del mes calculado con `aportes-carro.calc` (vía resumenCarro).
   */
  async resumenWhatsApp(ownerUserId: bigint, periodoPedido?: string) {
    const resumen = await this.resumenCarro(ownerUserId, { periodo: periodoPedido });
    const periodo = resumen.periodos.find((p) => p.id === resumen.periodoSeleccionadoId) ?? resumen.periodos[0] ?? null;
    if (!periodo) return { periodo: periodoPedido ?? resumen.periodoActual, ultimoAporte: null, resumenPeriodo: null, responsable: resumen.responsable };
    const porPersona = new Map<string, Decimal>();
    let ultimo: { fecha: string; aportante: string; monto: Decimal; concepto: string | null } | null = null;
    for (const dia of periodo.aportes) {
      for (const d of dia.detalles) {
        const nombre = d.personaNombre ?? '—';
        porPersona.set(nombre, (porPersona.get(nombre) ?? new Decimal(0)).plus(toDecimal(d.valor)));
        if (!ultimo) {
          ultimo = { fecha: dia.fecha.toISOString().slice(0, 10), aportante: nombre, monto: toDecimal(d.valor), concepto: d.comentarios ?? dia.notas };
        }
      }
    }
    const personaTel = periodo.responsable
      ? await this.prisma.personas.findFirst({
          where: { id: periodo.responsable.id, owner_user_id: ownerUserId },
          select: { numero_celular: true },
        })
      : null;
    return {
      periodo: periodo.periodo,
      nombrePeriodoMes: nombrePeriodo(periodo.periodo),
      responsable: periodo.responsable ? { ...periodo.responsable, telefono: personaTel?.numero_celular ?? null } : null,
      ultimoAporte: ultimo ? { ...ultimo, monto: money(ultimo.monto) } : null,
      resumenPeriodo: {
        nombrePeriodoMes: nombrePeriodo(periodo.periodo),
        metaMes: periodo.valorCuotaObjetivo,
        totalRecaudadoMes: periodo.montoAbonado,
        desglosePorPersona: [...porPersona.entries()].map(([nombre, monto]) => ({ nombre, monto: money(monto) })).sort((a, b) => b.monto.comparedTo(a.monto)),
        excedenteAcumulado: periodo.saldoAFavorDisponible,
        saldoFaltanteMes: periodo.saldoPendiente,
      },
    };
  }

  /**
   * Fase 6: transferencias de INGRESO recientes aún no vinculadas a un aporte del carro,
   * ordenadas por cercanía de monto y fecha a las pedidas (para asociarlas en 1 clic).
   */
  async transferenciasSugeridas(ownerUserId: bigint, opciones: { monto?: number | string; fecha?: string } = {}) {
    const [ingresos, vinculados] = await Promise.all([
      this.prisma.transacciones.findMany({
        where: { owner_user_id: ownerUserId, tipo_transaccion: TipoTransaccion.INGRESO },
        include: { cuenta_destino: { select: { id: true, nombre: true } } },
        orderBy: [{ fecha_transaccion: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.aportesDetalle.findMany({ where: { transaccion_id: { not: null } }, select: { transaccion_id: true } }),
    ]);
    const usados = new Set(vinculados.map((v) => String(v.transaccion_id)));
    const montoPedido = opciones.monto === undefined ? null : toDecimal(opciones.monto);
    const fechaPedido = opciones.fecha ? parseIsoDate(opciones.fecha) : null;
    return ingresos
      .filter((t) => t.estado !== EstadoTransaccion.ANULADO && !usados.has(String(t.id)))
      .map((t) => ({
        id: Number(t.id),
        fecha: t.fecha_transaccion.toISOString().slice(0, 10),
        concepto: t.concepto,
        monto: money(toDecimal(t.monto_cop)),
        cuentaDestinoId: t.cuenta_destino_id ? Number(t.cuenta_destino_id) : null,
        cuentaNombre: t.cuenta_destino?.nombre ?? null,
        diferenciaMonto: montoPedido ? money(toDecimal(t.monto_cop).minus(montoPedido).abs()) : null,
        diferenciaDias: fechaPedido ? Math.abs(Math.round((t.fecha_transaccion.getTime() - fechaPedido.getTime()) / 86_400_000)) : null,
      }))
      .sort((a, b) => Number(a.diferenciaMonto ?? 0) - Number(b.diferenciaMonto ?? 0) || (a.diferenciaDias ?? 0) - (b.diferenciaDias ?? 0))
      .slice(0, 10)
      .map(({ diferenciaMonto, diferenciaDias, ...resto }) => ({ ...resto, diferenciaMonto, diferenciaDias }));
  }

  // ───────────────────────────── Periodos ─────────────────────────────

  /** `POST /periodos`: crea el periodo del mes o actualiza su cuota objetivo. */
  async guardarPeriodo(dto: GuardarPeriodoDto, ownerUserId: bigint) {
    const tipo = dto.tipoObligacion ?? TipoObligacionMes.CUOTA_CARRO;
    const cuota = money(toDecimal(dto.valorCuota));
    if (!cuota.greaterThan(0)) throw datosInvalidos({ valorCuota: ['valorCuota debe ser mayor a 0'] });

    const { id, creado } = await this.prisma.$transaction(async (tx) => {
      const existente = await tx.obligacionesMes.findFirst({
        where: { owner_user_id: ownerUserId, tipo_obligacion: tipo, periodo: dto.periodo },
      });
      if (existente) {
        await tx.obligacionesMes.update({
          where: { id: existente.id },
          data: { meta_mensual: toDbMoney(cuota), ...(dto.concepto ? { concepto: dto.concepto } : {}) },
        });
        return { id: existente.id, creado: false };
      }
      const responsableId = dto.responsablePrincipalId
        ? await assertPersona(tx, dto.responsablePrincipalId, ownerUserId)
        : (await this.periodoBase(tx, ownerUserId, tipo, dto.periodo))?.responsable_principal_id;
      if (!responsableId) {
        throw datosInvalidos({ responsablePrincipalId: ['Indica el responsable de la cuota: aún no hay periodos de este tipo'] });
      }
      const nuevo = await tx.obligacionesMes.create({
        data: {
          owner_user_id: ownerUserId,
          tipo_obligacion: tipo,
          responsable_principal_id: responsableId,
          concepto: dto.concepto ?? nombrePeriodo(dto.periodo),
          periodo: dto.periodo,
          meta_mensual: toDbMoney(cuota),
          fecha_inicio: primerDiaPeriodo(dto.periodo),
          fecha_final: ultimoDiaPeriodo(dto.periodo),
          estado: 'ABIERTO',
        },
      });
      return { id: nuevo.id, creado: true };
    }, TX_OPCIONES);

    return { creado, periodo: await this.vistaPeriodoPorId(id, ownerUserId) };
  }

  // ───────────────────────────── Aportes diarios ─────────────────────────────

  /** `POST /aportes-diarios`: cabecera del día + N líneas de desglose, en una transacción. */
  async registrarAporteDiario(dto: CrearAporteDiarioDto, ownerUserId: bigint) {
    const fecha = this.exigirFecha(dto.fecha);
    const diaId = await this.prisma.$transaction(async (tx) => {
      const obligacion = await this.resolverPeriodo(tx, ownerUserId, dto, fecha);
      const miPersonaId = await this.miPersona(tx, ownerUserId);
      const dia = await this.buscarOCrearDia(tx, obligacion.id, fecha, dto.notas);
      const ctx: ContextoDia = { dia, obligacion, fecha, miPersonaId };
      for (const detalle of dto.detalles) await this.crearDetalle(tx, ctx, detalle, ownerUserId);
      return dia.id;
    }, TX_OPCIONES);
    return this.resultadoDia(diaId, ownerUserId);
  }

  /**
   * `PUT /aportes-diarios/:id`: reemplaza el día. Los detalles que llegan con `id` y no cambian se conservan (con su
   * cruce, su aprobación y su transacción); los modificados se revierten y se vuelven a crear; los ausentes se borran.
   */
  async actualizarAporteDiario(id: number, dto: ActualizarAporteDiarioDto, ownerUserId: bigint) {
    const fecha = this.exigirFecha(dto.fecha);
    await this.prisma.$transaction(async (tx) => {
      const dia = await this.cargarDia(tx, id, ownerUserId);
      const cambiaPeriodo = dto.periodo !== undefined || dto.obligacionMesId !== undefined;
      const obligacion = cambiaPeriodo ? await this.resolverPeriodo(tx, ownerUserId, dto, fecha) : dia.obligacion_mes;
      const fechaCambio = fecha.getTime() !== dia.fecha.getTime();
      const miPersonaId = await this.miPersona(tx, ownerUserId);

      const porId = new Map(dia.detalles.map((d) => [Number(d.id), d]));
      const conservar = new Map<number, DetalleAporteDiarioDto>();
      const crear: DetalleAporteDiarioDto[] = [];
      for (const entrante of dto.detalles) {
        if (entrante.id === undefined) {
          crear.push(entrante);
          continue;
        }
        const actual = porId.get(entrante.id);
        if (!actual) throw datosInvalidos({ detalles: [`El detalle ${entrante.id} no pertenece a este aporte diario`] });
        const sinCambios =
          !fechaCambio &&
          BigInt(entrante.personaId) === actual.persona_id &&
          igual(money(toDecimal(entrante.valor)), actual.valor) &&
          entrante.metodo === actual.metodo &&
          // La cuenta y el origen que no se envían se consideran «los de siempre» (p. ej. la cuenta EFECTIVO por defecto).
          (entrante.cuentaFinancieraId === undefined || entrante.cuentaFinancieraId === num(actual.cuenta_financiera_id)) &&
          (entrante.origenObligacionMesId === undefined || entrante.origenObligacionMesId === num(actual.origen_obligacion_mes_id));
        if (sinCambios) conservar.set(entrante.id, entrante);
        else crear.push({ ...entrante, id: undefined });
      }

      // 1) revertir lo que se quita o se cambia (si un cruce ya fue pagado, todo se revierte con el 409)
      for (const actual of dia.detalles) {
        if (!conservar.has(Number(actual.id))) await this.revertirYBorrarDetalle(tx, actual, ownerUserId);
      }
      // 2) cabecera del día
      await tx.aportesDia.update({
        where: { id: dia.id },
        data: { fecha, notas: dto.notas ?? null, obligacion_mes_id: obligacion.id },
      });
      // 3) comentarios de los detalles que se conservan
      for (const [detalleId, entrante] of conservar) {
        const actual = porId.get(detalleId) as Detalle;
        if ((entrante.comentarios ?? null) !== (actual.comentarios ?? null)) {
          await tx.aportesDetalle.update({ where: { id: actual.id }, data: { comentarios: entrante.comentarios ?? null } });
        }
      }
      // 4) crear los nuevos / modificados
      const ctx: ContextoDia = { dia, obligacion, fecha, miPersonaId };
      for (const nuevo of crear) await this.crearDetalle(tx, ctx, nuevo, ownerUserId);
    }, TX_OPCIONES);
    return this.resultadoDia(BigInt(id), ownerUserId);
  }

  /** `DELETE /aportes-diarios/:id`: revierte cruces, transacciones y saldo a favor, y borra el día. */
  async eliminarAporteDiario(id: number, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const dia = await this.cargarDia(tx, id, ownerUserId);
      let crucesAnulados = 0;
      let transaccionesAnuladas = 0;
      for (const detalle of dia.detalles) {
        const r = await this.revertirYBorrarDetalle(tx, detalle, ownerUserId);
        if (r.anuloCruce) crucesAnulados += 1;
        if (r.anuloTransaccion) transaccionesAnuladas += 1;
      }
      await tx.aportesDia.delete({ where: { id: dia.id } });
      return { eliminado: true, aporteDiarioId: id, detallesEliminados: dia.detalles.length, crucesAnulados, transaccionesAnuladas };
    }, TX_OPCIONES);
  }

  // ───────────────────────────── Saldo a favor ─────────────────────────────

  /**
   * `POST /periodos/:id/aplicar-excedente`: traslada el saldo a favor de un mes al siguiente (aporte SALDO_A_FAVOR con
   * trazabilidad al periodo de origen) o lo cruza contra el estado de cuenta de fin de mes del responsable (abono en el sub-ledger).
   */
  async aplicarExcedente(periodoId: number, dto: AplicarExcedenteDto, ownerUserId: bigint) {
    const hoy = todayLocal();
    const resultado = await this.prisma.$transaction(async (tx) => {
      const origen = await assertObligacion(tx, periodoId, ownerUserId);
      await this.bloquearPeriodo(tx, origen.id);
      const estado = await this.estadoPeriodo(tx, origen.id);
      const valor = dto.valor === undefined ? estado.saldoAFavorDisponible : money(toDecimal(dto.valor));
      if (!valor.greaterThan(0)) {
        throw datosInvalidos({ valor: [`No hay saldo a favor disponible en ${origen.concepto}`] });
      }
      if (valor.greaterThan(estado.saldoAFavorDisponible)) {
        throw datosInvalidos({ valor: [`Solo hay ${estado.saldoAFavorDisponible.toString()} de saldo a favor disponible en ${origen.concepto}`] });
      }

      if (dto.destino === DestinoExcedente.SIGUIENTE_MES) {
        const siguiente = await this.resolverPeriodo(tx, ownerUserId, { periodo: addMesesPeriodo(origen.periodo, 1), tipoObligacion: origen.tipo_obligacion as TipoObligacionMes }, hoy);
        const dia = await this.buscarOCrearDia(tx, siguiente.id, hoy, `Saldo a favor de ${origen.concepto}`);
        const ctx: ContextoDia = { dia, obligacion: siguiente, fecha: hoy, miPersonaId: await this.miPersona(tx, ownerUserId) };
        await this.crearDetalle(
          tx,
          ctx,
          {
            valor: valor.toString(),
            metodo: 'SALDO_A_FAVOR' as DetalleAporteDiarioDto['metodo'],
            personaId: Number(origen.responsable_principal_id),
            comentarios: `Saldo a favor trasladado de ${origen.concepto}`,
            origenObligacionMesId: Number(origen.id),
          },
          ownerUserId,
        );
        return { destino: dto.destino, valor, periodoDestinoId: siguiente.id, movimientoId: null as bigint | null };
      }

      const periodoImputacion = dto.periodoImputacion ?? periodoActual();
      if (!isValidPeriodo(periodoImputacion)) throw datosInvalidos({ periodoImputacion: ['periodoImputacion debe tener formato YYYY-MM'] });
      const movimiento = await tx.movimientosDeudaPersona.create({
        data: {
          owner_user_id: ownerUserId,
          persona_id: origen.responsable_principal_id,
          fecha_movimiento: hoy,
          periodo_imputacion: periodoImputacion,
          tipo_movimiento: TipoMovimientoDeuda.ABONO_SALDO_FAVOR_CARRO,
          signo: -1,
          monto: toDbMoney(valor),
          obligacion_mes_id: origen.id,
          concepto: `Saldo a favor ${origen.concepto} aplicado al estado de cuenta`,
          estado: EstadoMovimientoDeuda.CONFIRMADO,
        },
      });
      await tx.obligacionesMes.update({ where: { id: origen.id }, data: { saldo_a_favor_aplicado: { increment: toDbMoney(valor) } } });
      return { destino: dto.destino, valor, periodoDestinoId: null as bigint | null, movimientoId: movimiento.id };
    }, TX_OPCIONES);

    return {
      destino: resultado.destino,
      valorAplicado: resultado.valor,
      movimientoId: resultado.movimientoId,
      periodoDestino: resultado.periodoDestinoId ? await this.vistaPeriodoPorId(resultado.periodoDestinoId, ownerUserId) : null,
      periodo: await this.vistaPeriodoPorId(BigInt(periodoId), ownerUserId),
    };
  }

  // ───────────────────────────── Detalles ─────────────────────────────

  private async crearDetalle(tx: Tx, ctx: ContextoDia, d: DetalleAporteDiarioDto, ownerUserId: bigint) {
    const valor = money(toDecimal(d.valor));
    if (!valor.greaterThan(0)) throw datosInvalidos({ valor: ['valor debe ser mayor a 0'] });
    const persona = await tx.personas.findFirst({ where: { id: BigInt(d.personaId), owner_user_id: ownerUserId }, select: PERSONA_SELECT });
    if (!persona) throw new NotFoundException(`Persona ${d.personaId} no encontrada`);

    const clase = clasificarMetodo(d.metodo);
    this.validarMetodoPersona(clase, d, persona, ctx);

    let origenId: bigint | null = null;
    if (clase === 'SALDO_A_FAVOR') origenId = await this.consumirSaldoAFavor(tx, ctx.obligacion, d, valor, ownerUserId);

    if (d.cuentaFinancieraId !== undefined && clase !== 'EFECTIVO' && clase !== 'TRANSFERENCIA') {
      throw datosInvalidos({ cuentaFinancieraId: ['La cuenta solo aplica a los aportes en efectivo o por transferencia'] });
    }
    if ((d.cuentaDestinoId !== undefined || d.transaccionId !== undefined) && clase !== 'TRANSFERENCIA' && d.medioPago !== 'TRANSFERENCIA') {
      throw datosInvalidos({ transaccionId: ['La cuenta destino y la transferencia asociada solo aplican a aportes por TRANSFERENCIA'] });
    }
    const cuenta = await this.resolverCuenta(tx, clase, d, ownerUserId);
    const medioPago = d.medioPago ?? (clase === 'TRANSFERENCIA' ? 'TRANSFERENCIA' : 'EFECTIVO');

    // Fase 6 · Modo 1: asociar una transferencia bancaria entrante ya existente (sin crear otro movimiento).
    let transaccionExistenteId: bigint | null = null;
    if (d.transaccionId !== undefined) {
      const existente = await tx.transacciones.findFirst({ where: { id: BigInt(d.transaccionId), owner_user_id: ownerUserId } });
      if (!existente) throw new NotFoundException(`Transacción ${d.transaccionId} no encontrada`);
      if (existente.estado === EstadoTransaccion.ANULADO) throw datosInvalidos({ transaccionId: ['La transacción está anulada'] });
      const yaVinculada = await tx.aportesDetalle.findFirst({ where: { transaccion_id: existente.id } });
      if (yaVinculada) throw new ConflictException(`La transacción ${d.transaccionId} ya está vinculada a otro aporte del carro`);
      transaccionExistenteId = existente.id;
      await tx.transacciones.update({
        where: { id: existente.id },
        data: { tags: normalizarTags([...(existente.tags ?? []), '#aporte-carro']) },
      });
    }

    // El Trigger 3 (BEFORE INSERT) completa `prestamo_cruce_generado_id` si la persona es un tercero.
    const detalle = await tx.aportesDetalle.create({
      data: {
        aporte_dia_id: ctx.dia.id,
        persona_id: persona.id,
        valor: toDbMoney(valor),
        metodo: d.metodo,
        comentarios: d.comentarios ?? null,
        cuenta_financiera_id: cuenta?.id ?? null,
        origen_obligacion_mes_id: origenId,
        medio_pago: medioPago,
        cuenta_destino_id: cuenta?.id ?? null,
        transaccion_id: transaccionExistenteId,
      },
    });

    if (!transaccionExistenteId && cuenta && (clase === 'EFECTIVO' || clase === 'TRANSFERENCIA')) {
      const ingreso = await this.transacciones.insertar(
        tx,
        {
          tipoTransaccion: TipoTransaccion.INGRESO,
          cuentaOrigenId: null,
          cuentaDestinoId: Number(cuenta.id),
          tarjetaPagadaId: null,
          categoriaId: null,
          fechaTransaccion: new Date(Date.UTC(ctx.fecha.getUTCFullYear(), ctx.fecha.getUTCMonth(), ctx.fecha.getUTCDate(), 12)),
          concepto: `Aporte ${ctx.obligacion.concepto} (${clase === 'EFECTIVO' ? 'efectivo' : 'transferencia'})`.slice(0, 255),
          monedaOriginal: 'COP',
          montoOriginal: valor.toString(),
          origenRegistro: OrigenRegistro.MANUAL,
          estado: EstadoTransaccion.CONFIRMADO,
          notas: `Aporte diario ${ctx.dia.id}`,
          tags: ['#aporte-carro'],
        },
        ownerUserId,
      );
      await tx.aportesDetalle.update({ where: { id: detalle.id }, data: { transaccion_id: ingreso.id } });
    }
    return detalle;
  }

  /** Reglas método ↔ persona: solo un CRUCE_CUENTAS (o un método heredado) puede registrarse a nombre de un tercero. */
  private validarMetodoPersona(
    clase: MetodoCanonico,
    d: DetalleAporteDiarioDto,
    persona: { id: bigint; nombre: string | null },
    ctx: ContextoDia,
  ): void {
    const esResponsable = persona.id === ctx.obligacion.responsable_principal_id;
    const esYo = ctx.miPersonaId !== null && persona.id === ctx.miPersonaId;
    if (clase === 'SALDO_A_FAVOR' && !esResponsable) {
      throw datosInvalidos({ personaId: ['El saldo a favor pertenece al responsable de la cuota'] });
    }
    if ((clase === 'EFECTIVO' || clase === 'TRANSFERENCIA') && !esResponsable && !esYo) {
      throw datosInvalidos({
        personaId: [
          `${nombreDe(persona)} no es el responsable de la cuota: si ${nombreDe(persona)} asume este valor, usa el método «Cruce de cuentas» ` +
            `(se abona a la cuota y se le carga a su cuenta por cobrar)`,
        ],
      });
    }
    if (clase !== 'SALDO_A_FAVOR' && d.origenObligacionMesId !== undefined) {
      throw datosInvalidos({ origenObligacionMesId: ['Solo aplica al método SALDO_A_FAVOR'] });
    }
  }

  /** Cuenta indicada (validada) o, para EFECTIVO, la primera cuenta activa de tipo EFECTIVO. */
  private async resolverCuenta(tx: Tx, clase: MetodoCanonico, d: DetalleAporteDiarioDto, ownerUserId: bigint) {
    if (clase !== 'EFECTIVO' && clase !== 'TRANSFERENCIA') return null;
    if (d.cuentaDestinoId !== undefined) return assertCuenta(tx, d.cuentaDestinoId, ownerUserId);
    if (d.cuentaFinancieraId !== undefined) return assertCuenta(tx, d.cuentaFinancieraId, ownerUserId);
    if (clase !== 'EFECTIVO') return null;
    return tx.cuentasFinancieras.findFirst({
      where: { owner_user_id: ownerUserId, tipo_cuenta: 'EFECTIVO', is_active: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Marca como aplicado el saldo a favor que trae un aporte SALDO_A_FAVOR; devuelve el periodo de origen. */
  private async consumirSaldoAFavor(
    tx: Tx,
    destino: ContextoDia['obligacion'],
    d: DetalleAporteDiarioDto,
    valor: Decimal,
    ownerUserId: bigint,
  ): Promise<bigint> {
    const origen = d.origenObligacionMesId
      ? await assertObligacion(tx, d.origenObligacionMesId, ownerUserId)
      : await tx.obligacionesMes.findFirst({
          where: { owner_user_id: ownerUserId, tipo_obligacion: destino.tipo_obligacion, periodo: addMesesPeriodo(destino.periodo, -1) },
        });
    if (!origen) throw datosInvalidos({ origenObligacionMesId: ['Indica el periodo del que sale el saldo a favor'] });
    if (origen.id === destino.id) throw datosInvalidos({ origenObligacionMesId: ['El saldo a favor debe venir de otro periodo'] });
    if (origen.responsable_principal_id !== destino.responsable_principal_id || origen.tipo_obligacion !== destino.tipo_obligacion) {
      throw datosInvalidos({ origenObligacionMesId: ['El saldo a favor debe ser del mismo responsable y tipo de obligación'] });
    }

    await this.bloquearPeriodo(tx, origen.id);
    const estado = await this.estadoPeriodo(tx, origen.id);
    if (valor.greaterThan(estado.saldoAFavorDisponible)) {
      throw datosInvalidos({ valor: [`Solo hay ${estado.saldoAFavorDisponible.toString()} de saldo a favor disponible en ${origen.concepto}`] });
    }
    await tx.obligacionesMes.update({ where: { id: origen.id }, data: { saldo_a_favor_aplicado: { increment: toDbMoney(valor) } } });
    return origen.id;
  }

  /**
   * Deshace un detalle y lo borra. Un cruce ya pagado no se puede revertir (el dinero ya se recibió): 409.
   */
  private async revertirYBorrarDetalle(tx: Tx, detalle: Detalle, ownerUserId: bigint) {
    let anuloCruce = false;
    let anuloTransaccion = false;

    if (detalle.prestamo_cruce_generado_id !== null) {
      const prestamo = await tx.prestamos.findFirst({ where: { id: detalle.prestamo_cruce_generado_id, owner_user_id: ownerUserId } });
      if (prestamo) {
        const estado = (prestamo.estado ?? '').toLowerCase();
        if (estado === EstadoPrestamo.PAGADO.toLowerCase()) {
          throw new ConflictException(
            `El cruce con ${nombreDe(detalle.persona)} ya fue pagado: no se puede modificar ni eliminar este aporte. ` +
              `Anula primero el pago de ese préstamo.`,
          );
        }
        // Trigger 4: al anular el préstamo se anulan sus asientos del sub-ledger (deja de contar en el estado de cuenta).
        if (estado !== EstadoPrestamo.ANULADO.toLowerCase()) {
          await tx.prestamos.update({ where: { id: prestamo.id }, data: { estado: EstadoPrestamo.ANULADO } });
          anuloCruce = true;
        }
      }
    }
    // El préstamo apunta al aporte (origen_cruce_aporte_id): se desvincula para poder borrar el detalle.
    await tx.prestamos.updateMany({ where: { origen_cruce_aporte_id: detalle.id }, data: { origen_cruce_aporte_id: null } });

    if (detalle.transaccion_id !== null) {
      // Trigger 2: pasar a ANULADO revierte el saldo de la cuenta; se conserva la transacción para auditoría.
      const r = await tx.transacciones.updateMany({
        where: { id: detalle.transaccion_id, owner_user_id: ownerUserId, estado: EstadoTransaccion.CONFIRMADO },
        data: { estado: EstadoTransaccion.ANULADO },
      });
      anuloTransaccion = r.count > 0;
    }

    if (detalle.origen_obligacion_mes_id !== null) {
      await tx.$executeRaw`
        UPDATE "ObligacionesMes"
        SET saldo_a_favor_aplicado = GREATEST(0, saldo_a_favor_aplicado - ${toDbMoney(toDecimal(detalle.valor))})
        WHERE id = ${detalle.origen_obligacion_mes_id}`;
    }

    await tx.aportesDetalle.delete({ where: { id: detalle.id } });
    return { anuloCruce, anuloTransaccion };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private exigirFecha(valor: string): Date {
    const fecha = parseIsoDate(valor);
    if (!fecha) throw datosInvalidos({ fecha: ['fecha debe tener formato yyyy-MM-dd'] });
    return fecha;
  }

  private async miPersona(tx: Tx, ownerUserId: bigint): Promise<bigint | null> {
    const yo = await tx.personas.findFirst({
      where: { owner_user_id: ownerUserId, OR: [{ linked_user_id: ownerUserId }, { legacy_appsheet_id: LEGACY_PERSONA_YO }] },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return yo?.id ?? null;
  }

  /** Periodo más cercano (anterior al pedido; si no hay, el más reciente) para heredar responsable y cuota. */
  private periodoBase(tx: Tx, ownerUserId: bigint, tipo: string, periodo: string) {
    return tx.obligacionesMes
      .findFirst({ where: { owner_user_id: ownerUserId, tipo_obligacion: tipo, periodo: { lt: periodo } }, orderBy: { periodo: 'desc' } })
      .then((anterior) => anterior ?? tx.obligacionesMes.findFirst({ where: { owner_user_id: ownerUserId, tipo_obligacion: tipo }, orderBy: { periodo: 'desc' } }));
  }

  /** Periodo por id o por mes; si el mes no existe se crea con la cuota y el responsable del periodo base. */
  private async resolverPeriodo(
    tx: Tx,
    ownerUserId: bigint,
    dto: { obligacionMesId?: number; periodo?: string; tipoObligacion?: TipoObligacionMes | string },
    fecha: Date,
  ) {
    if (dto.obligacionMesId !== undefined) return assertObligacion(tx, dto.obligacionMesId, ownerUserId);

    const tipo = dto.tipoObligacion ?? TipoObligacionMes.CUOTA_CARRO;
    const periodo = dto.periodo ?? periodoOf(fecha);
    const existente = await tx.obligacionesMes.findFirst({ where: { owner_user_id: ownerUserId, tipo_obligacion: tipo, periodo } });
    if (existente) return existente;

    const base = await this.periodoBase(tx, ownerUserId, tipo, periodo);
    if (!base) {
      throw datosInvalidos({ periodo: [`No hay una cuota configurada para ${nombrePeriodo(periodo)}: define el valor de la cuota primero`] });
    }
    return tx.obligacionesMes.create({
      data: {
        owner_user_id: ownerUserId,
        tipo_obligacion: tipo,
        responsable_principal_id: base.responsable_principal_id,
        concepto: nombrePeriodo(periodo),
        periodo,
        meta_mensual: base.meta_mensual,
        fecha_inicio: primerDiaPeriodo(periodo),
        fecha_final: ultimoDiaPeriodo(periodo),
        estado: 'ABIERTO',
      },
    });
  }

  private async buscarOCrearDia(tx: Tx, obligacionId: bigint, fecha: Date, notas?: string) {
    const existente = await tx.aportesDia.findFirst({ where: { obligacion_mes_id: obligacionId, fecha } });
    if (existente) {
      if (notas !== undefined && notas !== existente.notas) {
        return tx.aportesDia.update({ where: { id: existente.id }, data: { notas } });
      }
      return existente;
    }
    return tx.aportesDia.create({ data: { obligacion_mes_id: obligacionId, fecha, notas: notas ?? null } });
  }

  private async cargarDia(tx: Tx, id: number, ownerUserId: bigint) {
    const dia = await tx.aportesDia.findFirst({
      where: { id: BigInt(id), obligacion_mes: { owner_user_id: ownerUserId } },
      include: { obligacion_mes: true, detalles: { include: INCLUDE_DETALLE, orderBy: { id: 'asc' } } },
    });
    if (!dia) throw new NotFoundException(`Aporte diario ${id} no encontrado`);
    return dia;
  }

  /** Serializa las operaciones de saldo a favor sobre un mismo periodo. */
  private async bloquearPeriodo(tx: Tx, obligacionId: bigint): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "ObligacionesMes" WHERE id = ${obligacionId} FOR UPDATE`;
  }

  private async estadoPeriodo(tx: Tx, obligacionId: bigint) {
    const o = await tx.obligacionesMes.findUniqueOrThrow({
      where: { id: obligacionId },
      select: { meta_mensual: true, saldo_a_favor_aplicado: true, dias: { select: { detalles: { select: { valor: true } } } } },
    });
    return calcularEstadoPeriodo(o.meta_mensual, o.dias.flatMap((d) => d.detalles.map((x) => x.valor)), o.saldo_a_favor_aplicado);
  }

  // ───────────────────────────── Vistas (respuestas) ─────────────────────────────

  private vistaPersona(p: { id: bigint; nombre: string | null; iniciales_nombre: string | null; color_representativo: string | null }) {
    return { id: p.id, nombre: p.nombre, iniciales: p.iniciales_nombre, color: p.color_representativo };
  }

  private vistaDetalle(d: Detalle) {
    const clase = clasificarMetodo(d.metodo);
    return {
      id: d.id,
      aporteDiarioId: d.aporte_dia_id,
      valor: money(toDecimal(d.valor)),
      metodo: d.metodo,
      metodoCanonico: clase,
      personaId: d.persona_id,
      personaNombre: d.persona.nombre,
      personaColor: d.persona.color_representativo,
      comentarios: d.comentarios,
      cuentaFinancieraId: d.cuenta_financiera_id,
      cuentaNombre: d.cuenta?.nombre ?? null,
      /** Fase 6: clasificación binaria y cuenta destino (sql/019). */
      medioPago: d.medio_pago ?? (clase === 'TRANSFERENCIA' ? 'TRANSFERENCIA' : 'EFECTIVO'),
      cuentaDestinoId: d.cuenta_destino_id ?? d.cuenta_financiera_id,
      transaccionId: d.transaccion_id,
      prestamoCruceGeneradoId: d.prestamo_cruce_generado_id,
      esCruce: d.prestamo_cruce_generado_id !== null || clase === 'CRUCE_CUENTAS',
      origenObligacionMesId: d.origen_obligacion_mes_id,
    };
  }

  private vistaDia(dia: Pick<Dia, 'id' | 'obligacion_mes_id' | 'fecha' | 'notas'> & { detalles: Detalle[] }, periodo: string) {
    return {
      id: dia.id,
      obligacionMesId: dia.obligacion_mes_id,
      periodo,
      fecha: dia.fecha,
      notas: dia.notas,
      valorTotal: sumar(dia.detalles),
      detalles: dia.detalles.map((d) => this.vistaDetalle(d)),
    };
  }

  private vistaPeriodo(p: Periodo, conAportes: boolean) {
    const detalles = p.dias.flatMap((d) => d.detalles);
    const estado = calcularEstadoPeriodo(p.meta_mensual, detalles.map((d) => d.valor), p.saldo_a_favor_aplicado);
    const vistos = detalles.map((d) => this.vistaDetalle(d));
    return {
      id: p.id,
      tipoObligacion: p.tipo_obligacion,
      periodo: p.periodo,
      concepto: p.concepto,
      responsable: this.vistaPersona(p.responsable_principal),
      ...estado,
      /** Compatibilidad con `/api/obligaciones-mes`: ABIERTO hasta alcanzar la cuota. */
      estadoCalculado: estado.montoAbonado.greaterThanOrEqualTo(estado.valorCuotaObjetivo) ? 'COMPLETADO' : 'ABIERTO',
      aportadoPorCruces: sumar(vistos.filter((d) => d.esCruce)),
      aportadoDirecto: sumar(vistos.filter((d) => !d.esCruce)),
      /** Fase 6: efectivo físico vs. transferencia en cuenta, y desglose por aportante. */
      ...resumenMediosPago(vistos),
      cantidadAportes: p.dias.length,
      aportes: conAportes ? p.dias.map((dia) => this.vistaDia(dia, p.periodo)) : [],
    };
  }

  private async vistaPeriodoPorId(id: bigint, ownerUserId: bigint) {
    const p = await this.prisma.obligacionesMes.findFirst({ where: { id, owner_user_id: ownerUserId }, include: INCLUDE_PERIODO });
    if (!p) throw new NotFoundException(`Periodo ${id} no encontrado`);
    return this.vistaPeriodo(p, false);
  }

  private async resultadoDia(diaId: bigint, ownerUserId: bigint) {
    const dia = await this.prisma.aportesDia.findFirst({
      where: { id: diaId, obligacion_mes: { owner_user_id: ownerUserId } },
      include: { obligacion_mes: { select: { periodo: true } }, detalles: { include: INCLUDE_DETALLE, orderBy: { id: 'asc' } } },
    });
    if (!dia) throw new NotFoundException(`Aporte diario ${diaId} no encontrado`);
    return {
      aporteDiario: this.vistaDia(dia, dia.obligacion_mes.periodo),
      periodo: await this.vistaPeriodoPorId(dia.obligacion_mes_id, ownerUserId),
      transaccionesCreadas: dia.detalles.filter((d) => d.transaccion_id !== null).length,
      crucesGenerados: dia.detalles.filter((d) => d.prestamo_cruce_generado_id !== null).length,
    };
  }
}
