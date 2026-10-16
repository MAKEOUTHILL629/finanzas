import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { EstadoTransaccion } from '../../common/enums/finance.enums';
import { money, rate, toDecimal } from '../../common/utils/decimal.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService } from '../compras-credito/compras-credito.service';
import { ResponsablesService } from '../compras-credito/responsables.service';
import { completarPlasticoDeCompra } from '../tarjetas/plasticos.db';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { ItemNormalizado, Plan } from './planificador-correos';
import { CompraSnap, NotificacionSnap, SnapshotCorreos, TransaccionSnap } from './snapshot-correos';

/** Persona «yo» según los triggers de la BD (enlazada al usuario, o la del Excel/AppSheet original). */
const LEGACY_YO = 'lm1R40P16oHgkM3Szu91du';
/** Tope de filas históricas que se cargan en memoria (compras, correos, transacciones). */
const MAX_FILAS = 5000;

export interface IdsCreados {
  compraId: bigint | null;
  transaccionId: bigint | null;
}

const dec = (v: Prisma.Decimal | null | undefined): Decimal | null => (v === null || v === undefined ? null : toDecimal(v));
const fechaIso = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '1970-01-01');

/**
 * Lee la fotografía del usuario para el planificador y ejecuta sus decisiones dentro de una transacción de BD
 * (crear la compra con sus responsables, crear la transacción, enlazar) dejando la notificación actualizada.
 */
@Injectable()
export class EjecutorCorreosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compras: ComprasCreditoService,
    private readonly transacciones: TransaccionesService,
    private readonly responsables: ResponsablesService,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────── fotografía ─────────────────────────────

  async cargarSnapshot(ownerUserId: bigint, opciones: { desdeFecha?: Date | null } = {}): Promise<SnapshotCorreos> {
    const [cuentas, tarjetas, personas, compras, notificaciones, transacciones, ultimaUsd] = await Promise.all([
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId, is_active: { not: false } },
        select: { id: true, ultimos_4_digitos: true, moneda: true, es_principal: true },
      }),
      this.prisma.tarjetas.findMany({ where: { owner_user_id: ownerUserId } }),
      this.prisma.personas.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, nombre: true, numero_celular: true, linked_user_id: true, legacy_appsheet_id: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId },
        select: {
          id: true,
          tarjeta: true,
          fecha_compra: true,
          valor_compra: true,
          moneda_original: true,
          valor_moneda_original: true,
          concepto: true,
          numero_cuotas: true,
          interes: true,
          notificaciones: { select: { id: true }, take: 1 },
          responsables: { select: { persona: true, porcentaje_pago: true, cantidad_cuotas: true }, orderBy: { id: 'asc' } },
        },
        orderBy: { id: 'desc' },
        take: MAX_FILAS,
      }),
      this.prisma.notificacionesCorreo.findMany({
        where: { owner_user_id: ownerUserId },
        select: {
          id: true,
          ultimos_4: true,
          monto_original: true,
          moneda: true,
          fecha_correo: true,
          comercio_normalizado: true,
          estado_procesamiento: true,
          compra_credito_generada_id: true,
          transaccion_generada_id: true,
          vinculo: true,
          datos_parseados: true,
        },
        orderBy: { id: 'desc' },
        take: MAX_FILAS,
      }),
      this.prisma.transacciones.findMany({
        where: {
          owner_user_id: ownerUserId,
          estado: { not: EstadoTransaccion.ANULADO },
          ...(opciones.desdeFecha ? { fecha_transaccion: { gte: new Date(opciones.desdeFecha.getTime() - 2 * 86_400_000) } } : {}),
        },
        select: {
          id: true,
          tipo_transaccion: true,
          estado: true,
          cuenta_origen_id: true,
          cuenta_destino_id: true,
          tarjeta_pagada_id: true,
          monto_cop: true,
          fecha_transaccion: true,
          notificaciones: { select: { id: true }, take: 1 },
        },
        orderBy: { id: 'desc' },
        take: MAX_FILAS,
      }),
      this.prisma.comprasCredito.findFirst({
        where: { owner_user_id: ownerUserId, moneda_original: 'USD', tasa_cambio_aplicada: { not: null } },
        orderBy: { id: 'desc' },
        select: { tasa_cambio_aplicada: true },
      }),
    ]);

    const yo = personas.find((p) => p.linked_user_id === ownerUserId) ?? personas.find((p) => p.legacy_appsheet_id === LEGACY_YO) ?? null;
    const trm = this.config.get<string | number>('DEFAULT_TRM_USD');

    return {
      ownerUserId,
      cuentas: cuentas.map((c) => ({ id: c.id, ultimos_4_digitos: c.ultimos_4_digitos, moneda: c.moneda, es_principal: c.es_principal === true })),
      tarjetas: tarjetas.map((t) => ({
        id: t.id,
        descripcion: t.descripcion,
        franquicia: t.franquicia,
        ultimos_4_digitos: t.ultimos_4_digitos,
        tasa_interes_compra: dec(t.tasa_interes_compra),
        tasa_interes_avance: dec(t.tasa_interes_avance),
      })),
      personas: personas.map((p) => ({ id: p.id, nombre: p.nombre, numero_celular: p.numero_celular })),
      miPersonaId: yo?.id ?? null,
      compras: compras.map(
        (c): CompraSnap => ({
          id: c.id,
          tarjetaId: c.tarjeta,
          fecha: fechaIso(c.fecha_compra),
          valorCop: toDecimal(c.valor_compra),
          moneda: c.moneda_original === 'USD' ? 'USD' : 'COP',
          valorOriginal: dec(c.valor_moneda_original),
          concepto: c.concepto ?? '',
          cuotas: c.numero_cuotas ?? 1,
          interes: dec(c.interes),
          vinculada: c.notificaciones.length > 0,
          responsables: c.responsables
            .filter((r): r is typeof r & { persona: bigint } => r.persona !== null)
            .map((r) => ({ personaId: r.persona, porcentaje: toDecimal(r.porcentaje_pago), cuotas: r.cantidad_cuotas })),
        }),
      ),
      transacciones: transacciones.map(
        (t): TransaccionSnap => ({
          id: t.id,
          tipo: t.tipo_transaccion,
          estado: t.estado ?? EstadoTransaccion.CONFIRMADO,
          cuentaOrigenId: t.cuenta_origen_id,
          cuentaDestinoId: t.cuenta_destino_id,
          tarjetaPagadaId: t.tarjeta_pagada_id,
          montoCop: toDecimal(t.monto_cop),
          fecha: t.fecha_transaccion,
          vinculada: t.notificaciones.length > 0,
        }),
      ),
      notificaciones: notificaciones.map(
        (n): NotificacionSnap => ({
          id: n.id,
          ultimos4: n.ultimos_4,
          monto: dec(n.monto_original),
          moneda: n.moneda,
          fecha: n.fecha_correo,
          comercioNorm: n.comercio_normalizado,
          ruta: typeof (n.datos_parseados as Record<string, unknown> | null)?.ruta === 'string' ? String((n.datos_parseados as Record<string, unknown>).ruta) : null,
          estado: n.estado_procesamiento ?? 'PENDIENTE',
          compraId: n.compra_credito_generada_id,
          transaccionId: n.transaccion_generada_id,
          vinculo: n.vinculo,
        }),
      ),
      offset: this.config.get<string>('SYNC_TZ_OFFSET') ?? '-05:00',
      trmRespaldo: trm === undefined || trm === null || trm === '' ? null : rate(toDecimal(trm)),
      ultimaTrmUsd: ultimaUsd?.tasa_cambio_aplicada ? rate(toDecimal(ultimaUsd.tasa_cambio_aplicada)) : null,
    };
  }

  // ───────────────────────────── ejecución ─────────────────────────────

  /** `datos_parseados` de la notificación: el contrato original + lo que el planificador dedujo. */
  datosParseados(item: ItemNormalizado, plan: Plan): Prisma.InputJsonObject {
    const a = plan.analisis;
    return {
      tipo: item.tipo,
      metodo: item.metodo,
      comercio: item.comercio ?? null,
      origenRaw: item.origenRaw ?? null,
      valor: item.valor === undefined || item.valor === null ? null : String(item.valor),
      moneda: a.moneda,
      linkCorreo: item.linkCorreo ?? null,
      ultimos_4: a.ultimos4,
      instrumento: a.instrumento,
      ruta: a.ruta,
      monto: a.monto?.toString() ?? null,
      fecha: item.fecha,
      hora: item.hora,
      motivo: plan.motivo,
      ...(plan.plantilla ? { plantilla: { ...plan.plantilla } } : {}),
      ...(a.personaId !== null ? { persona_id: Number(a.personaId) } : {}),
    };
  }

  /** Datos que se escriben en la notificación al terminar de procesarla. */
  datosNotificacion(item: ItemNormalizado, plan: Plan, ids: IdsCreados): Prisma.NotificacionesCorreoUncheckedUpdateInput {
    const a = plan.analisis;
    return {
      estado_procesamiento: plan.estado,
      transaccion_generada_id: ids.transaccionId,
      compra_credito_generada_id: ids.compraId,
      datos_parseados: this.datosParseados(item, plan),
      ultimos_4: a.ultimos4,
      comercio_normalizado: a.comercioNorm || null,
      monto_original: a.monto ? a.monto.toString() : null,
      moneda: a.moneda,
      tarjeta_id: a.tarjetaId,
      cuenta_id: a.cuentaId,
      persona_id: a.personaId,
      vinculo: plan.vinculo,
      notificacion_original_id: plan.notificacionOriginalId,
    };
  }

  /** Ejecuta la acción del plan y deja la notificación actualizada. Va dentro de la transacción del llamador. */
  async aplicar(
    tx: Prisma.TransactionClient,
    p: { item: ItemNormalizado; plan: Plan; ownerUserId: bigint; notificacionId: bigint },
  ): Promise<IdsCreados> {
    const { item, plan, ownerUserId } = p;
    const ids = await this.ejecutarAccion(tx, item, plan, ownerUserId);
    await tx.notificacionesCorreo.update({ where: { id: p.notificacionId }, data: this.datosNotificacion(item, plan, ids) });
    return ids;
  }

  private async ejecutarAccion(tx: Prisma.TransactionClient, item: ItemNormalizado, plan: Plan, ownerUserId: bigint): Promise<IdsCreados> {
    const accion = plan.accion;
    switch (accion.tipo) {
      case 'CREAR_COMPRA': {
        const usd = accion.moneda === 'USD' && accion.tasa;
        const compraId = await this.compras.saveTx(
          tx,
          {
            concepto: accion.concepto,
            valorCompra: accion.moneda === 'COP' ? accion.valorCop.toString() : undefined,
            fechaCompra: accion.fechaCompra,
            numeroCuotas: accion.numeroCuotas,
            interes: accion.interes.toString(),
            descripcion: accion.descripcion,
            estado: 'Pendiente',
            tarjeta: accion.tarjetaId,
            // El aviso del banco dice con qué plástico se pagó (los 4 dígitos); si no coincide con uno registrado se usa el vigente a la fecha.
            plasticoUltimos4: plan.analisis.ultimos4,
            ...(usd
              ? { monedaOriginal: 'USD', valorMonedaOriginal: accion.valorOriginal.toString(), tasaCambioAplicada: (accion.tasa as Decimal).toString(), trmConfirmada: false }
              : {}),
          },
          ownerUserId,
        );
        for (const r of accion.responsables) {
          await this.responsables.createTx(
            tx,
            {
              persona: Number(r.personaId),
              porcentajePago: r.porcentaje.toString(),
              cantidadPago: money(accion.valorCop.mul(r.porcentaje).div(100)).toString(),
              cantidadCuotas: r.cuotas ?? accion.numeroCuotas,
              compraCredito: compraId,
            },
            ownerUserId,
          );
        }
        return { compraId: BigInt(compraId), transaccionId: null };
      }
      case 'VINCULAR_COMPRA':
        // La compra ya existía (sin plástico, si es anterior a sql/004): el aviso aporta con cuál se pagó.
        await completarPlasticoDeCompra(tx, accion.compraId, plan.analisis.ultimos4);
        return { compraId: accion.compraId, transaccionId: null };
      case 'CREAR_TRANSACCION': {
        const t = await this.transacciones.insertar(tx, accion.datos, ownerUserId, { permitirPagoTarjetaSinTarjeta: accion.permitirPagoTarjetaSinTarjeta });
        return { compraId: null, transaccionId: t.id };
      }
      case 'VINCULAR_TRANSACCION': {
        if (accion.completarTarjetaId !== null) {
          await tx.transacciones.update({ where: { id: accion.transaccionId }, data: { tarjeta_pagada_id: accion.completarTarjetaId } });
        }
        return { compraId: null, transaccionId: accion.transaccionId };
      }
      default:
        return { compraId: null, transaccionId: null };
    }
  }
}
