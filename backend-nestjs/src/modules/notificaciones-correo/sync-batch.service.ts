import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { construirFechaHora, prioridadRuta, RutaSync } from './bancolombia-normalizer.util';
import { NotificacionItemDto } from './dto/sync-batch.dto';
import { EjecutorCorreosService } from './ejecutor-correos.service';
import { insertarNotificacionIdempotente } from './notificaciones.repository';
import { planificar, Plan } from './planificador-correos';
import { ProductosCorreoService, AprendizajeTarjeta } from './productos-correo.service';
import { aplicarPlanASnapshot, SnapshotCorreos } from './snapshot-correos';

export type ResultadoItem = 'INSERTADO' | 'EXISTENTE' | 'ERROR';

export interface DetalleItemSync {
  externalMessageId: string;
  resultado: ResultadoItem;
  ruta?: RutaSync;
  estadoProcesamiento?: string;
  transaccionId?: number | null;
  compraCreditoId?: number | null;
  motivo?: string | null;
  /** CREADA = la app registró algo; EXISTENTE = se enlazó a algo que ya existía; DUPLICADO = otro correo del mismo hecho. */
  vinculo?: string | null;
  error?: string;
}

export interface SyncBatchResult {
  totalRecibidos: number;
  nuevosInsertados: number;
  yaExistentesIdempotentes: number;
  /** IDs ya persistidos (nuevos + idempotentes): el script puede marcarlos como sincronizados. */
  syncedExternalIds: string[];
  /** Ítems que fallaron por un error transitorio (se revirtieron): NO están en `syncedExternalIds`. */
  errores: Array<{ externalMessageId: string; error: string }>;
  detalle: DetalleItemSync[];
  /** Últimos 4 dígitos que se asociaron solos a una tarjeta (evidencia: compras con igual fecha y monto). */
  aprendizajes?: AprendizajeTarjeta[];
}

const REMITENTE = 'Bancolombia (Gmail)';

/**
 * Sincronización por lotes de las notificaciones de Bancolombia (webhook del Google Apps Script).
 *
 * Idempotente por `external_message_id`. Cada ítem se procesa en su PROPIA transacción: si uno falla se revierte
 * solo ese ítem y se reporta en `errores` (no entra a `syncedExternalIds`, así el script lo reintenta).
 * La decisión de qué hacer con cada correo la toma el planificador (`planificador-correos.ts`, sin BD): enlazar a lo que
 * ya existe, crear con los valores habituales del comercio, marcar duplicados o dejar pendiente con su motivo.
 * NO se duplica lógica de la BD: el saldo lo mueve el Trigger 2 (transacciones CONFIRMADO) y el sub-ledger los
 * triggers 1/6/8 al crear compras y cuotas.
 */
@Injectable()
export class SyncBatchService {
  private readonly logger = new Logger(SyncBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ejecutor: EjecutorCorreosService,
    private readonly productos: ProductosCorreoService,
  ) {}

  async syncBatch(items: NotificacionItemDto[], ownerUserId: bigint): Promise<SyncBatchResult> {
    const resultado: SyncBatchResult = {
      totalRecibidos: items.length,
      nuevosInsertados: 0,
      yaExistentesIdempotentes: 0,
      syncedExternalIds: [],
      errores: [],
      detalle: [],
    };
    const existente = (id: string) => {
      resultado.yaExistentesIdempotentes += 1;
      resultado.syncedExternalIds.push(id);
      resultado.detalle.push({ externalMessageId: id, resultado: 'EXISTENTE' });
    };

    // 1. Duplicados dentro del propio lote
    const vistos = new Set<string>();
    const unicos: NotificacionItemDto[] = [];
    for (const item of items) {
      if (vistos.has(item.externalMessageId)) existente(item.externalMessageId);
      else {
        vistos.add(item.externalMessageId);
        unicos.push(item);
      }
    }

    // 2. Ya existentes en BD (idempotencia estricta)
    const enBd = new Set(
      (
        await this.prisma.notificacionesCorreo.findMany({
          where: { external_message_id: { in: unicos.map((i) => i.externalMessageId) } },
          select: { external_message_id: true },
        })
      ).map((n) => n.external_message_id),
    );
    const nuevos = unicos.filter((i) => {
      if (enBd.has(i.externalMessageId)) {
        existente(i.externalMessageId);
        return false;
      }
      return true;
    });
    if (nuevos.length === 0) return resultado;

    // 3. Lo que ya se sabe del usuario (cuentas, tarjetas, personas, compras, correos): una sola lectura por lote
    const snap = await this.ejecutor.cargarSnapshot(ownerUserId);

    // 4. Orden cronológico (débito antes que abono del mismo pago) y 5. proceso aislado por ítem
    const ordenados = [...nuevos].sort((a, b) => {
      const ta = construirFechaHora(a.fecha, a.hora, snap.offset)?.getTime() ?? 0;
      const tb = construirFechaHora(b.fecha, b.hora, snap.offset)?.getTime() ?? 0;
      return ta - tb || prioridadRuta(a) - prioridadRuta(b);
    });

    for (const item of ordenados) {
      try {
        const procesado = await this.prisma.$transaction((tx) => this.procesarItem(tx, item, snap, ownerUserId), TX_OPTIONS);
        if (procesado === 'EXISTENTE') {
          existente(item.externalMessageId);
        } else {
          resultado.nuevosInsertados += 1;
          resultado.syncedExternalIds.push(item.externalMessageId);
          resultado.detalle.push(procesado.detalle);
          // Solo tras confirmar la transacción: los correos siguientes ya «ven» lo creado o enlazado.
          aplicarPlanASnapshot(snap, procesado.plan, procesado.ids, procesado.fecha);
        }
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : String(error);
        this.logger.error(`No se pudo sincronizar ${item.externalMessageId}: ${mensaje}`);
        resultado.errores.push({ externalMessageId: item.externalMessageId, error: mensaje });
        resultado.detalle.push({ externalMessageId: item.externalMessageId, resultado: 'ERROR', error: mensaje });
      }
    }

    // 6. Aprendizaje: si ya hay evidencia suficiente, los últimos 4 dígitos nuevos se asocian solos a su tarjeta.
    try {
      const aprendizajes = await this.productos.inferirTarjetas(ownerUserId, { aplicar: true });
      const aplicados = aprendizajes.filter((a) => a.aplicado);
      if (aplicados.length > 0) resultado.aprendizajes = aplicados;
    } catch (error) {
      this.logger.warn(`No se pudieron inferir tarjetas: ${error instanceof Error ? error.message : String(error)}`);
    }
    return resultado;
  }

  // ───────────────────────────── ítem ─────────────────────────────

  private async procesarItem(
    tx: Prisma.TransactionClient,
    item: NotificacionItemDto,
    snap: SnapshotCorreos,
    ownerUserId: bigint,
  ): Promise<'EXISTENTE' | { detalle: DetalleItemSync; plan: Plan; ids: { notificacionId: bigint; compraId: bigint | null; transaccionId: bigint | null }; fecha: Date }> {
    const plan = planificar(item, snap);
    const fechaCorreo = plan.analisis.fecha ?? new Date();

    const notificacionId = await insertarNotificacionIdempotente(tx, {
      ownerUserId,
      externalMessageId: item.externalMessageId,
      remitente: REMITENTE,
      asunto: item.asunto ?? `${item.tipo} · ${item.metodo}`,
      fechaCorreo,
      cuerpoExtraido: item.cuerpoExtraido ?? null,
      datosParseados: this.ejecutor.datosParseados(item, plan) as Record<string, unknown>,
    });
    if (notificacionId === null) return 'EXISTENTE';

    const ids = await this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId });
    return {
      plan,
      fecha: fechaCorreo,
      ids: { notificacionId, ...ids },
      detalle: {
        externalMessageId: item.externalMessageId,
        resultado: 'INSERTADO',
        ruta: plan.analisis.ruta,
        estadoProcesamiento: plan.estado,
        transaccionId: ids.transaccionId === null ? null : Number(ids.transaccionId),
        compraCreditoId: ids.compraId === null ? null : Number(ids.compraId),
        motivo: plan.motivo,
        vinculo: plan.vinculo,
      },
    };
  }
}
