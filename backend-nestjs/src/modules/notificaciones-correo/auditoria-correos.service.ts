import { Injectable } from '@nestjs/common';
import { EstadoNotificacionCorreo, EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService, TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { clasificarIntencionCorreo } from './clasificador-correo.util';
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

/**
 * Auditoría retroactiva de falsos positivos (Fase 1): correos históricos que generaron una compra
 * pero eran pagos de tarjeta o compras rechazadas. Preview sin escribir; la reversión elimina la
 * compra creada por ese correo (si no tiene cruces) o la convierte en pago de tarjeta.
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
      const cuerpo = interpretarCuerpo(n.cuerpo_extraido);
      const clasif = clasificarIntencionCorreo([n.asunto, n.cuerpo_extraido]);
      const tipo = cuerpo.rechazada || clasif.tipoIntencion === 'TRANSACCION_RECHAZADA'
        ? 'TRANSACCION_RECHAZADA'
        : cuerpo.pagoTarjeta || clasif.tipoIntencion === 'PAGO_ABONO_TARJETA'
          ? 'PAGO_ABONO_TARJETA'
          : null;
      if (!tipo || !n.compra_credito_generada_id) continue;
      // Bloqueo: compra ya pagada por completo no se toca automáticamente.
      const compra = await this.prisma.comprasCredito.findFirst({ where: { id: n.compra_credito_generada_id, owner_user_id: ownerUserId }, select: { estado: true } });
      const bloqueada = (compra?.estado ?? '').toLowerCase() === 'pagado';
      const datos = (n.datos_parseados ?? {}) as Record<string, unknown>;
      resultado.push({
        notificacionId: idNum(n.id),
        compraId: idNum(n.compra_credito_generada_id),
        fecha: n.fecha_correo,
        comercio: typeof datos.comercio === 'string' ? datos.comercio : null,
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
          await this.compras.deleteTx(tx, f.compraId as number, ownerUserId);
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
}
