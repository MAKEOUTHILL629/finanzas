import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoNotificacionCorreo, EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { Decimal } from '../../config/decimal.config';
import { toDecimal } from '../../common/utils/decimal.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService, TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { clasificarIntencionCorreo, detectarPatronRechazo } from './clasificador-correo.util';
import { interpretarCuerpo } from './cuerpo-correo.util';

export interface FalsoPositivoDetectado {
  notificacionId: number;
  compraId: number | null;
  fecha: Date;
  comercio: string | null;
  monto: string | null;
  tipoDetectado: 'TRANSACCION_RECHAZADA' | 'PAGO_ABONO_TARJETA';
  accionSugerida: 'ELIMINAR_COMPRA' | 'CONVERTIR_EN_PAGO_TARJETA' | 'SOLO_MARCAR';
  puedeRevertir: boolean;
  motivoBloqueo: string | null;
}

export interface RechazadoHistoricoDetectado {
  notificacionId: number;
  fecha: Date;
  asunto: string | null;
  comercio: string | null;
  monto: string | null;
  patronDetectado: string;
  estadoActual: string;
  compraId: number | null;
  cuotasAsociadas: number;
  responsablesAsociados: number;
  movimientosDeudaAsociados: number;
  transaccionId: number | null;
  cuentaAfectadaId: number | null;
  nombreCuenta: string | null;
  impactoSaldoCop: string | null;
}

export interface ReporteAuditoriaRechazados {
  ejecutado: boolean;
  correosRechazadosDetectados: number;
  correosActualizadosADescartado: number;
  comprasCreditoEliminadas: number;
  cuotasEliminadas: number;
  responsablesEliminados: number;
  movimientosDeudaEliminados: number;
  transaccionesEliminadas: number;
  saldosCuentasRestaurados: Array<{ cuentaId: number; nombreCuenta: string; diferenciaRestaurada: string }>;
  items: RechazadoHistoricoDetectado[];
}

/**
 * Auditoría retroactiva de falsos positivos y purga en cascada de transacciones rechazadas históricas (Fase 1).
 */
@Injectable()
export class AuditoriaCorreosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compras: ComprasCreditoService,
    private readonly transacciones: TransaccionesService,
  ) {}

  async auditar(ownerUserId: bigint): Promise<{ total: number; falsosPositivos: FalsoPositivoDetectado[] }> {
    const filas = await this.prisma.notificacionesCorreo.findMany({
      where: { owner_user_id: ownerUserId, compra_credito_generada_id: { not: null } },
      orderBy: { fecha_correo: 'desc' },
      take: 5000,
    });
    const resultado: FalsoPositivoDetectado[] = [];
    for (const n of filas) {
      const datos = (n.datos_parseados ?? {}) as Record<string, unknown>;
      const comercio = typeof datos.comercio === 'string' ? datos.comercio : null;
      const tipoRaw = typeof datos.tipo === 'string' ? datos.tipo : null;
      const cuerpo = interpretarCuerpo(n.cuerpo_extraido);
      const clasif = clasificarIntencionCorreo([n.asunto, comercio, tipoRaw, n.cuerpo_extraido]);
      const tipo = cuerpo.rechazada || clasif.tipoIntencion === 'TRANSACCION_RECHAZADA'
        ? 'TRANSACCION_RECHAZADA'
        : cuerpo.pagoTarjeta || clasif.tipoIntencion === 'PAGO_ABONO_TARJETA'
          ? 'PAGO_ABONO_TARJETA'
          : null;
      if (!tipo || !n.compra_credito_generada_id) continue;
      // Para compras rechazadas permitimos revertir siempre; para pagos de tarjeta bloqueamos si la compra ya figura pagada.
      const compra = await this.prisma.comprasCredito.findFirst({ where: { id: n.compra_credito_generada_id, owner_user_id: ownerUserId }, select: { estado: true } });
      const bloqueada = tipo !== 'TRANSACCION_RECHAZADA' && (compra?.estado ?? '').toLowerCase() === 'pagado';
      resultado.push({
        notificacionId: idNum(n.id),
        compraId: idNum(n.compra_credito_generada_id),
        fecha: n.fecha_correo,
        comercio,
        monto: n.monto_original?.toString() ?? null,
        tipoDetectado: tipo,
        accionSugerida: tipo === 'PAGO_ABONO_TARJETA' ? 'CONVERTIR_EN_PAGO_TARJETA' : 'ELIMINAR_COMPRA',
        puedeRevertir: !bloqueada,
        motivoBloqueo: bloqueada ? 'compra_pagada_no_revertible' : null,
      });
    }
    return { total: resultado.length, falsosPositivos: resultado };
  }

  async revertir(ownerUserId: bigint, ids?: number[]): Promise<{ revertidos: number; convertidos: number; omitidos: Array<{ notificacionId: number; motivo: string }> }> {
    const { falsosPositivos } = await this.auditar(ownerUserId);
    const seleccion = ids?.length ? falsosPositivos.filter((f) => ids.includes(f.notificacionId)) : falsosPositivos;
    let revertidos = 0;
    let convertidos = 0;
    const omitidos: Array<{ notificacionId: number; motivo: string }> = [];
    for (const f of seleccion) {
      if (!f.puedeRevertir || !f.compraId) {
        omitidos.push({ notificacionId: f.notificacionId, motivo: f.motivoBloqueo ?? 'sin_compra' });
        continue;
      }
      try {
        await this.prisma.$transaction(async (tx) => {
          const n = await tx.notificacionesCorreo.findFirstOrThrow({ where: { id: BigInt(f.notificacionId), owner_user_id: ownerUserId } });
          await this.compras.deleteTx(tx, f.compraId as number, ownerUserId, { desdeDeshacer: true });
          if (f.tipoDetectado === 'PAGO_ABONO_TARJETA' && n.cuenta_id && n.tarjeta_id && n.monto_original) {
            const t = await this.transacciones.insertar(
              tx,
              {
                tipoTransaccion: TipoTransaccion.PAGO_TARJETA,
                cuentaOrigenId: idNum(n.cuenta_id),
                cuentaDestinoId: null,
                tarjetaPagadaId: idNum(n.tarjeta_id),
                categoriaId: null,
                fechaTransaccion: n.fecha_correo,
                concepto: 'Pago de tarjeta (reclasificado desde correo)',
                monedaOriginal: 'COP',
                montoOriginal: n.monto_original.toString(),
                origenRegistro: OrigenRegistro.EMAIL_AUTO,
                estado: EstadoTransaccion.CONFIRMADO,
                notas: `Reclasificado por auditoría de falsos positivos (notificación ${f.notificacionId})`,
              },
              ownerUserId,
              { permitirPagoTarjetaSinTarjeta: false },
            );
            await tx.notificacionesCorreo.update({
              where: { id: n.id },
              data: { estado_procesamiento: EstadoNotificacionCorreo.CONCILIADO, transaccion_generada_id: t.id, compra_credito_generada_id: null },
            });
            convertidos += 1;
          } else {
            await tx.notificacionesCorreo.update({
              where: { id: n.id },
              data: {
                estado_procesamiento: f.tipoDetectado === 'TRANSACCION_RECHAZADA' ? EstadoNotificacionCorreo.DESCARTADO_RECHAZADO : EstadoNotificacionCorreo.IGNORADO,
                compra_credito_generada_id: null,
              },
            });
            revertidos += 1;
          }
        }, TX_OPTIONS);
      } catch (e) {
        omitidos.push({ notificacionId: f.notificacionId, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
    return { revertidos, convertidos, omitidos };
  }

  /**
   * Fase 1 (Iteración 2): Escanea todos los correos de `NotificacionesCorreo` del usuario (y compras/transacciones
   * huérfanas con texto de rechazo), identifica los que corresponden a transacciones rechazadas o fallidas y, si
   * `ejecutarBorrado = true`, elimina en cascada dentro de una transacción `prisma.$transaction`:
   *  - MovimientosDeudaPersona asociados
   *  - ResponsablesComprasCredito asociados
   *  - CuotasDetalle asociadas
   *  - ComprasCredito generadas por el correo rechazado
   *  - Transacciones generadas por el correo rechazado (restaurando automáticamente el saldo de CuentasFinancieras vía Trigger 2)
   *  - Actualiza `NotificacionesCorreo.estado_procesamiento = 'DESCARTADO_RECHAZADO'` y limpia sus FKs.
   */
  async auditarYLimpiarRechazadosHistoricos(
    ownerUserId: bigint,
    ejecutarBorrado = false,
    ids?: number[],
  ): Promise<ReporteAuditoriaRechazados> {
    const [notificaciones, cuentas] = await Promise.all([
      this.prisma.notificacionesCorreo.findMany({
        where: { owner_user_id: ownerUserId },
        orderBy: { fecha_correo: 'desc' },
        take: 5000,
      }),
      this.prisma.cuentasFinancieras.findMany({
        where: { owner_user_id: ownerUserId },
        select: { id: true, nombre: true },
      }),
    ]);
    const mapaCuentas = new Map<number, string>(cuentas.map((c) => [idNum(c.id), c.nombre]));

    const candidatos: Array<{
      notificacion: (typeof notificaciones)[number];
      patron: string;
      comercio: string | null;
    }> = [];

    for (const n of notificaciones) {
      const datos = (n.datos_parseados ?? {}) as Record<string, unknown>;
      const comercio = typeof datos.comercio === 'string' ? datos.comercio : null;
      const tipoRaw = typeof datos.tipo === 'string' ? datos.tipo : null;
      const motivoRaw = typeof datos.motivo === 'string' ? datos.motivo : null;
      const cuerpo = interpretarCuerpo(n.cuerpo_extraido);
      const patronTexto = detectarPatronRechazo([n.asunto, comercio, tipoRaw, n.cuerpo_extraido]);
      const esRechazado =
        cuerpo.rechazada ||
        patronTexto !== null ||
        n.estado_procesamiento === EstadoNotificacionCorreo.DESCARTADO_RECHAZADO ||
        motivoRaw === 'compra_rechazada_o_no_exitosa';

      if (!esRechazado) continue;

      const tieneAsociados = n.compra_credito_generada_id !== null || n.transaccion_generada_id !== null;
      const requiereCambioEstado = n.estado_procesamiento !== EstadoNotificacionCorreo.DESCARTADO_RECHAZADO;
      if (tieneAsociados || requiereCambioEstado) {
        candidatos.push({
          notificacion: n,
          patron: cuerpo.patronRechazo ?? patronTexto ?? 'compra_rechazada_o_no_exitosa',
          comercio,
        });
      }
    }

    const compraIds = [...new Set(candidatos.map((c) => c.notificacion.compra_credito_generada_id).filter((id): id is bigint => id !== null))];
    const transaccionIds = [...new Set(candidatos.map((c) => c.notificacion.transaccion_generada_id).filter((id): id is bigint => id !== null))];

    const [cuotasPorCompra, responsablesPorCompra, transaccionesAsociadas] = await Promise.all([
      compraIds.length > 0
        ? this.prisma.cuotasDetalle.findMany({
            where: { compra: { in: compraIds } },
            select: { id: true, compra: true },
          })
        : Promise.resolve([]),
      compraIds.length > 0
        ? this.prisma.responsablesComprasCredito.findMany({
            where: { compra_credito: { in: compraIds } },
            select: { id: true, compra_credito: true },
          })
        : Promise.resolve([]),
      transaccionIds.length > 0
        ? this.prisma.transacciones.findMany({
            where: { id: { in: transaccionIds }, owner_user_id: ownerUserId },
            select: {
              id: true,
              estado: true,
              tipo_transaccion: true,
              cuenta_origen_id: true,
              cuenta_destino_id: true,
              monto_cop: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const cuotaIds = cuotasPorCompra.map((c) => c.id);
    const responsableIds = responsablesPorCompra.map((r) => r.id);
    const movimientosDeuda =
      cuotaIds.length > 0 || responsableIds.length > 0 || transaccionIds.length > 0
        ? await this.prisma.movimientosDeudaPersona.findMany({
            where: {
              owner_user_id: ownerUserId,
              OR: [
                ...(cuotaIds.length > 0 ? [{ cuota_detalle_id: { in: cuotaIds } }] : []),
                ...(responsableIds.length > 0 ? [{ responsable_compra_id: { in: responsableIds } }] : []),
                ...(transaccionIds.length > 0 ? [{ transaccion_id: { in: transaccionIds } }] : []),
              ],
            },
            select: { id: true, cuota_detalle_id: true, responsable_compra_id: true, transaccion_id: true },
          })
        : [];

    const items: RechazadoHistoricoDetectado[] = candidatos.map(({ notificacion: n, patron, comercio }) => {
      const cId = n.compra_credito_generada_id;
      const tId = n.transaccion_generada_id;
      const cuotasDeCompra = cId ? cuotasPorCompra.filter((c) => c.compra === cId) : [];
      const respsDeCompra = cId ? responsablesPorCompra.filter((r) => r.compra_credito === cId) : [];
      const setCuotas = new Set(cuotasDeCompra.map((c) => c.id));
      const setResps = new Set(respsDeCompra.map((r) => r.id));
      const movs = movimientosDeuda.filter(
        (m) =>
          (m.cuota_detalle_id !== null && setCuotas.has(m.cuota_detalle_id)) ||
          (m.responsable_compra_id !== null && setResps.has(m.responsable_compra_id)) ||
          (tId !== null && m.transaccion_id === tId),
      );
      const txRow = tId ? transaccionesAsociadas.find((t) => t.id === tId) : undefined;
      const cuentaId = txRow ? (txRow.cuenta_origen_id ?? txRow.cuenta_destino_id) : null;
      let impactoSaldoCop: string | null = null;
      if (txRow && txRow.estado === EstadoTransaccion.CONFIRMADO && cuentaId !== null) {
        const monto = toDecimal(txRow.monto_cop);
        // Si fue EGRESO/PAGO_TARJETA se restó de cuenta_origen → al eliminar se suma (+monto). Si fue INGRESO se sumó → al eliminar se resta (-monto).
        const signo = txRow.cuenta_origen_id !== null ? new Decimal(1) : new Decimal(-1);
        impactoSaldoCop = monto.mul(signo).toFixed(2);
      }

      return {
        notificacionId: idNum(n.id),
        fecha: n.fecha_correo,
        asunto: n.asunto,
        comercio,
        monto: n.monto_original?.toString() ?? null,
        patronDetectado: patron,
        estadoActual: n.estado_procesamiento ?? 'PENDIENTE',
        compraId: cId ? idNum(cId) : null,
        cuotasAsociadas: cuotasDeCompra.length,
        responsablesAsociados: respsDeCompra.length,
        movimientosDeudaAsociados: movs.length,
        transaccionId: tId ? idNum(tId) : null,
        cuentaAfectadaId: cuentaId ? idNum(cuentaId) : null,
        nombreCuenta: cuentaId ? (mapaCuentas.get(idNum(cuentaId)) ?? `Cuenta #${idNum(cuentaId)}`) : null,
        impactoSaldoCop,
      };
    });

    const seleccionados = ids?.length ? items.filter((i) => ids.includes(i.notificacionId)) : items;

    const saldosMap = new Map<number, Decimal>();
    for (const item of seleccionados) {
      if (item.cuentaAfectadaId !== null && item.impactoSaldoCop !== null) {
        const prev = saldosMap.get(item.cuentaAfectadaId) ?? new Decimal(0);
        saldosMap.set(item.cuentaAfectadaId, prev.plus(toDecimal(item.impactoSaldoCop)));
      }
    }

    if (!ejecutarBorrado || seleccionados.length === 0) {
      return {
        ejecutado: false,
        correosRechazadosDetectados: seleccionados.length,
        correosActualizadosADescartado: seleccionados.filter((i) => i.estadoActual !== EstadoNotificacionCorreo.DESCARTADO_RECHAZADO).length,
        comprasCreditoEliminadas: new Set(seleccionados.map((i) => i.compraId).filter((v): v is number => v !== null)).size,
        cuotasEliminadas: seleccionados.reduce((acc, i) => acc + i.cuotasAsociadas, 0),
        responsablesEliminados: seleccionados.reduce((acc, i) => acc + i.responsablesAsociados, 0),
        movimientosDeudaEliminados: seleccionados.reduce((acc, i) => acc + i.movimientosDeudaAsociados, 0),
        transaccionesEliminadas: new Set(seleccionados.map((i) => i.transaccionId).filter((v): v is number => v !== null)).size,
        saldosCuentasRestaurados: [...saldosMap.entries()].map(([cuentaId, diff]) => ({
          cuentaId,
          nombreCuenta: mapaCuentas.get(cuentaId) ?? `Cuenta #${cuentaId}`,
          diferenciaRestaurada: diff.toFixed(2),
        })),
        items: seleccionados,
      };
    }

    let correosActualizadosADescartado = 0;
    let comprasCreditoEliminadas = 0;
    let cuotasEliminadas = 0;
    let responsablesEliminados = 0;
    let movimientosDeudaEliminados = 0;
    let transaccionesEliminadas = 0;

    await this.prisma.$transaction(async (tx) => {
      const comprasBorradas = new Set<number>();
      const transaccionesBorradas = new Set<number>();

      for (const item of seleccionados) {
        const notif = await tx.notificacionesCorreo.findFirst({
          where: { id: BigInt(item.notificacionId), owner_user_id: ownerUserId },
        });
        if (!notif) continue;

        const datosActuales = (notif.datos_parseados ?? {}) as Record<string, unknown>;
        const datosNuevos: Prisma.InputJsonObject = {
          ...datosActuales,
          es_compra_valida: false,
          tipo_intencion: 'TRANSACCION_RECHAZADA',
          tipo_evento: 'RECHAZADO',
          motivo: 'compra_rechazada_o_no_exitosa',
          motivo_rechazo: item.patronDetectado,
        };

        // 1. Desvincular el correo y marcarlo como DESCARTADO_RECHAZADO
        await tx.notificacionesCorreo.update({
          where: { id: notif.id },
          data: {
            estado_procesamiento: EstadoNotificacionCorreo.DESCARTADO_RECHAZADO,
            compra_credito_generada_id: null,
            transaccion_generada_id: null,
            vinculo: null,
            datos_parseados: datosNuevos,
          },
        });
        correosActualizadosADescartado += 1;

        // 2. Eliminar CompraCredito y sus registros hijos en cascada
        if (item.compraId !== null && !comprasBorradas.has(item.compraId)) {
          const compraExistente = await tx.comprasCredito.findFirst({
            where: { id: BigInt(item.compraId), owner_user_id: ownerUserId },
            select: { id: true },
          });
          if (compraExistente) {
            cuotasEliminadas += item.cuotasAsociadas;
            responsablesEliminados += item.responsablesAsociados;
            movimientosDeudaEliminados += item.movimientosDeudaAsociados;
            await this.compras.deleteTx(tx, item.compraId, ownerUserId, { desdeDeshacer: true });
            comprasBorradas.add(item.compraId);
            comprasCreditoEliminadas += 1;
          }
        }

        // 3. Eliminar Transacción asociada (Trigger 2 restaura saldo_actual en CuentasFinancieras automáticamente)
        if (item.transaccionId !== null && !transaccionesBorradas.has(item.transaccionId)) {
          const txExistente = await tx.transacciones.findFirst({
            where: { id: BigInt(item.transaccionId), owner_user_id: ownerUserId },
            select: { id: true },
          });
          if (txExistente) {
            const movsTx = await tx.movimientosDeudaPersona.deleteMany({
              where: { transaccion_id: txExistente.id, owner_user_id: ownerUserId },
            });
            if (item.compraId === null) {
              movimientosDeudaEliminados += movsTx.count;
            }
            await tx.notificacionesCorreo.updateMany({
              where: { transaccion_generada_id: txExistente.id },
              data: { transaccion_generada_id: null },
            });
            await tx.periodosRecurrentes.updateMany({
              where: { transaccion_pago_id: txExistente.id },
              data: { transaccion_pago_id: null },
            });
            await tx.transacciones.delete({ where: { id: txExistente.id } });
            transaccionesBorradas.add(item.transaccionId);
            transaccionesEliminadas += 1;
          }
        }
      }
    }, TX_OPTIONS);

    return {
      ejecutado: true,
      correosRechazadosDetectados: seleccionados.length,
      correosActualizadosADescartado,
      comprasCreditoEliminadas,
      cuotasEliminadas,
      responsablesEliminados,
      movimientosDeudaEliminados,
      transaccionesEliminadas,
      saldosCuentasRestaurados: [...saldosMap.entries()].map(([cuentaId, diff]) => ({
        cuentaId,
        nombreCuenta: mapaCuentas.get(cuentaId) ?? `Cuenta #${cuentaId}`,
        diferenciaRestaurada: diff.toFixed(2),
      })),
      items: seleccionados,
    };
  }
}
