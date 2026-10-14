import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ComprasCredito, Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import {
  calcularAmortizacion,
  calcularPagoMensualTotal,
  CuotaCalculada,
} from '../../common/utils/calculadora-amortizacion.util';
import { parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, rate, sumDecimals, toDb, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { dateToMillis, idNum, num, numOrNull, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CompraCreditoInput } from './dto/compra-credito.dto';

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
}

@Injectable()
export class ComprasCreditoService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── Lecturas ─────────────────────────────

  /** `GET /api/compras-credito` — incluye `responsables` ("1,2") y `porcentajePago` (Σ), como el JOIN legacy. */
  async list(ownerUserId: bigint): Promise<CompraCreditoJson[]> {
    const compras = await this.prisma.comprasCredito.findMany({
      where: { owner_user_id: ownerUserId },
      include: { responsables: { select: { persona: true, porcentaje_pago: true }, orderBy: { id: 'asc' } } },
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
      ),
    );
  }

  /** `GET /api/compras-credito/detalle/:id` — `null` si no existe (Json.toJson(None)). */
  async getById(id: number, ownerUserId: bigint): Promise<CompraCreditoJson | null> {
    const compra = await this.prisma.comprasCredito.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    return compra ? this.toJson(compra, '', 0) : null;
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
      select: { id: true, dia_corte: true },
    });
    if (!tarjeta) throw new Error(`No se encontró la tarjeta con ID ${input.tarjeta}`);

    const amortizacion = calcularAmortizacion(
      valores.valorCompra,
      valores.interes,
      input.numeroCuotas,
      valores.fechaCompra,
      false,
      tarjeta.dia_corte,
    );
    const fechaUltimaCuota = amortizacion[amortizacion.length - 1].fechaPago;

    const compra = await tx.comprasCredito.create({
      data: {
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

    return this.prisma.$transaction(async (tx) => {
      const existente = await this.requireCompra(tx, compraId, ownerUserId);
      const valores = this.resolverValores(input, existente);

      const tarjeta = await tx.tarjetas.findFirst({
        where: { id: BigInt(input.tarjeta), owner_user_id: ownerUserId },
        select: { id: true },
      });
      if (!tarjeta) throw new Error(`No se encontró la tarjeta con ID ${input.tarjeta}`);

      const actualizada = await tx.comprasCredito.update({
        where: { id: existente.id },
        data: {
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
        },
      });
      return this.recalcularTx(tx, actualizada);
    }, TX_OPTIONS);
  }

  /**
   * `recalcularCuotas(compraId, ownerUserId)`: relee la compra, recalcula la tabla de amortización y sincroniza
   * `CuotasDetalle` respetando la Regla 4. Si el concepto contiene "Ajuste de Interes" cobra interés en la cuota 1.
   */
  async recalcularCuotas(compraId: number, ownerUserId: bigint): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const compra = await this.requireCompra(tx, compraId, ownerUserId);
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

    const amortizacion = calcularAmortizacion(
      valorCompra,
      interes,
      numeroCuotas,
      compra.fecha_compra,
      cobraInteresPrimeraCuota,
      tarjeta?.dia_corte,
    );

    await this.reemplazarCuotas(tx, compra.id, amortizacion);

    const resultado = await tx.comprasCredito.updateMany({
      where: { id: compra.id },
      data: {
        fecha_ultima_cuota: amortizacion[amortizacion.length - 1].fechaPago,
        pago_mensual: toDb(calcularPagoMensualTotal(valorCompra, interes, numeroCuotas)),
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
  async deleteTx(tx: Tx, compraId: number, ownerUserId: bigint): Promise<void> {
    const compra = await this.requireCompra(tx, compraId, ownerUserId);

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

  // ───────────────────────────── helpers ─────────────────────────────

  async requireCompra(tx: Tx, compraId: number, ownerUserId: bigint): Promise<ComprasCredito> {
    const compra = await tx.comprasCredito.findFirst({ where: { id: BigInt(compraId), owner_user_id: ownerUserId } });
    if (!compra) throw new Error(`No se encontró la compra con ID ${compraId}`);
    return compra;
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

  private cuotasData(compraId: bigint, cuotas: CuotaCalculada[]): Prisma.CuotasDetalleCreateManyInput[] {
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

  toJson(c: ComprasCredito, responsables: string, porcentajePago: number): CompraCreditoJson {
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
    };
  }
}
