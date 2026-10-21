import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificacionesCorreo } from '@prisma/client';
import { EstadoNotificacionCorreo } from '../../common/enums/finance.enums';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { construirFechaHora, prioridadRuta, tokensDe4Digitos } from './bancolombia-normalizer.util';
import { detectarPatronRechazo } from './clasificador-correo.util';
import { interpretarCuerpo } from './cuerpo-correo.util';
import { ReprocesarDto } from './dto/productos-correo.dto';
import { EjecutorCorreosService } from './ejecutor-correos.service';
import { ItemNormalizado, planificar } from './planificador-correos';
import { agregarUltimos4, AprendizajeTarjeta, ProductosCorreoService } from './productos-correo.service';
import { aplicarPlanASnapshot, CuentaSnap, PersonaSnap, SnapshotCorreos, TarjetaSnap } from './snapshot-correos';

export interface MuestraReproceso {
  notificacionId: number;
  fecha: string;
  comercio: string | null;
  monto: string | null;
  moneda: string;
  accion: string;
  motivo: string;
  vinculo: string | null;
}

export interface ResumenReproceso {
  simulado: boolean;
  desde: string | null;
  evaluados: number;
  /** Conteo por lo que se hizo (o se haría) con cada correo. */
  acciones: Record<string, number>;
  /** Conteo por motivo (los pendientes explican por qué no se pudieron resolver). */
  motivos: Record<string, number>;
  omitidos: number;
  errores: Array<{ notificacionId: number; error: string }>;
  muestras: MuestraReproceso[];
  aprendizajes: AprendizajeTarjeta[];
}

export interface BulkReprocesoContext {
  snapshot: SnapshotCorreos;
  tarjetasPorId: Map<bigint, TarjetaSnap>;
  tarjetasPorUltimos4: Map<string, TarjetaSnap>;
  cuentasPorId: Map<bigint, CuentaSnap>;
  cuentasPorUltimos4: Map<string, CuentaSnap>;
  personasPorId: Map<bigint, PersonaSnap>;
  aprendizajes: AprendizajeTarjeta[];
}

export interface ResultadoReprocesoBulk {
  totalEvaluados: number;
  conciliados: number;
  descartadosRechazados: number;
  ignorados: number;
  duplicados: number;
  pendientesRestantes: number;
  errores: number;
  omitidos: number;
  comprasCreadas: number;
  comprasEnlazadas: number;
  transaccionesCreadas: number;
  transaccionesEnlazadas: number;
  tiempoTotalMs: number;
  velocidadCorreosPorSegundo: number;
  acciones: Record<string, number>;
  motivos: Record<string, number>;
  muestras: MuestraReproceso[];
  aprendizajes: AprendizajeTarjeta[];
  detalleErrores: Array<{ notificacionId: number; error: string }>;
}

export interface EstadoTrabajo {
  jobId: string;
  estado: 'EN_CURSO' | 'TERMINADO' | 'FALLIDO';
  total: number;
  procesados: number;
  iniciado: Date;
  terminado: Date | null;
  resumen: ResumenReproceso | null;
  error: string | null;
}

interface Trabajo extends EstadoTrabajo {
  ownerUserId: bigint;
}

const MAX_MUESTRAS = 60;
const CHUNK_SIZE_DEFAULT = 50;
const BULK_TX_OPTIONS = { ...TX_OPTIONS, timeout: 25000, maxWait: 10000 };

const ACCIONES: Record<string, string> = {
  NINGUNA: 'sin_cambios',
  DUPLICADO: 'duplicados',
  VINCULAR_COMPRA: 'compras_enlazadas',
  CREAR_COMPRA: 'compras_creadas',
  VINCULAR_TRANSACCION: 'transacciones_enlazadas',
  CREAR_TRANSACCION: 'transacciones_creadas',
};

/**
 * Reprocesa los correos PENDIENTES con la inteligencia actual (productos con sus últimos 4 dígitos, compras equivalentes,
 * plantillas por comercio, duplicados): enlaza lo que ya existe y registra lo que falta. Es la forma de «ponerse al día» tras
 * asignar las cuentas y tarjetas, sin reenviar los correos desde Gmail.
 */
@Injectable()
export class ReprocesoCorreosService {
  private readonly logger = new Logger(ReprocesoCorreosService.name);
  private readonly trabajos = new Map<string, Trabajo>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ejecutor: EjecutorCorreosService,
    private readonly productos: ProductosCorreoService,
  ) {}

  /**
   * Fase 2 (Iteración 2): Construye en memoria el `BulkReprocesoContext` precargando en una sola tanda
   * tarjetas, plásticos/últimos 4, cuentas, personas, compras, transacciones y notificaciones históricas.
   */
  async cargarContextoBulk(
    ownerUserId: bigint,
    aplicarAprendizajes: boolean,
    desdeFecha: Date | null = null,
  ): Promise<BulkReprocesoContext> {
    const aprendizajes = await this.productos.inferirTarjetas(ownerUserId, { aplicar: aplicarAprendizajes });
    const snapshot = await this.ejecutor.cargarSnapshot(ownerUserId, { desdeFecha });

    for (const a of aprendizajes) {
      const t = snapshot.tarjetas.find((x) => x.id === BigInt(a.tarjetaId));
      if (t && !t.ultimos_4_digitos?.includes(a.ultimos4)) {
        t.ultimos_4_digitos = agregarUltimos4(t.ultimos_4_digitos, a.ultimos4);
      }
    }

    const tarjetasPorId = new Map<bigint, TarjetaSnap>();
    const tarjetasPorUltimos4 = new Map<string, TarjetaSnap>();
    for (const t of snapshot.tarjetas) {
      tarjetasPorId.set(t.id, t);
      for (const u4 of tokensDe4Digitos(`${t.ultimos_4_digitos ?? ''} ${t.descripcion ?? ''} ${t.franquicia ?? ''}`)) {
        if (!tarjetasPorUltimos4.has(u4)) tarjetasPorUltimos4.set(u4, t);
      }
    }

    const cuentasPorId = new Map<bigint, CuentaSnap>();
    const cuentasPorUltimos4 = new Map<string, CuentaSnap>();
    for (const c of snapshot.cuentas) {
      cuentasPorId.set(c.id, c);
      for (const u4 of tokensDe4Digitos(c.ultimos_4_digitos)) {
        if (!cuentasPorUltimos4.has(u4)) cuentasPorUltimos4.set(u4, c);
      }
    }

    const personasPorId = new Map<bigint, PersonaSnap>();
    for (const p of snapshot.personas) {
      personasPorId.set(p.id, p);
    }

    return {
      snapshot,
      tarjetasPorId,
      tarjetasPorUltimos4,
      cuentasPorId,
      cuentasPorUltimos4,
      personasPorId,
      aprendizajes,
    };
  }

  /**
   * Fase 2 (Iteración 2): Motor Backend Bulk para reprocesar todos los correos pendientes en sub-lotes
   * transaccionales (`chunkSize` = 50) con contexto pre-cargado en memoria.
   */
  async reprocesarPendientesEnLote(dto: ReprocesarDto, ownerUserId: bigint): Promise<ResultadoReprocesoBulk> {
    const t0 = Date.now();
    const chunkSize = Math.min(100, Math.max(10, dto.chunkSize ?? CHUNK_SIZE_DEFAULT));
    const estadosAProcesar = dto.incluirConError
      ? [EstadoNotificacionCorreo.PENDIENTE, EstadoNotificacionCorreo.ERROR]
      : [EstadoNotificacionCorreo.PENDIENTE];

    const todos = await this.prisma.notificacionesCorreo.findMany({
      where: {
        owner_user_id: ownerUserId,
        estado_procesamiento: { in: estadosAProcesar },
        compra_credito_generada_id: null,
        transaccion_generada_id: null,
        ...(dto.ids?.length ? { id: { in: dto.ids.map((i) => BigInt(i)) } } : {}),
      },
      orderBy: [{ fecha_correo: 'asc' }, { id: 'asc' }],
    });

    const filas = dto.motivos?.length
      ? todos.filter((n) => dto.motivos?.includes(String((n.datos_parseados as Record<string, unknown> | null)?.motivo ?? '')))
      : todos;

    const ctx = await this.cargarContextoBulk(ownerUserId, dto.simular === false, filas[0]?.fecha_correo ?? null);
    const snap = ctx.snapshot;

    let desde: Date | null = null;
    if (dto.desde) {
      desde = construirFechaHora(dto.desde.slice(0, 10), '00:00', snap.offset);
      if (!desde) throw datosInvalidos({ desde: ['desde debe tener formato yyyy-MM-dd'] });
    }

    let omitidos = 0;
    const ordenadas = filas
      .map((n) => ({ fila: n, item: this.itemDeConFallback(n) }))
      .filter((x): x is { fila: NotificacionesCorreo; item: ItemNormalizado } => {
        if (!x.item) omitidos += 1;
        return x.item !== null;
      })
      .sort(
        (a, b) =>
          a.fila.fecha_correo.getTime() - b.fila.fecha_correo.getTime() ||
          prioridadRuta(a.item) - prioridadRuta(b.item) ||
          Number(a.fila.id - b.fila.id),
      );

    const resultado: ResultadoReprocesoBulk = {
      totalEvaluados: 0,
      conciliados: 0,
      descartadosRechazados: 0,
      ignorados: 0,
      duplicados: 0,
      pendientesRestantes: 0,
      errores: 0,
      omitidos,
      comprasCreadas: 0,
      comprasEnlazadas: 0,
      transaccionesCreadas: 0,
      transaccionesEnlazadas: 0,
      tiempoTotalMs: 0,
      velocidadCorreosPorSegundo: 0,
      acciones: {},
      motivos: {},
      muestras: [],
      aprendizajes: ctx.aprendizajes,
      detalleErrores: [],
    };

    const simular = dto.simular === true;
    let virtual = -1n;

    for (let i = 0; i < ordenadas.length; i += chunkSize) {
      const chunk = ordenadas.slice(i, i + chunkSize);

      if (simular) {
        for (const { fila, item } of chunk) {
          const plan = planificar(item, snap, { desde, notificacionId: fila.id });
          let ids = { compraId: null as bigint | null, transaccionId: null as bigint | null };
          if (plan.accion.tipo === 'CREAR_COMPRA') ids = { compraId: virtual--, transaccionId: null };
          else if (plan.accion.tipo === 'CREAR_TRANSACCION') ids = { compraId: null, transaccionId: virtual-- };
          else if (plan.accion.tipo === 'VINCULAR_COMPRA') ids = { compraId: plan.accion.compraId, transaccionId: null };
          else if (plan.accion.tipo === 'VINCULAR_TRANSACCION') ids = { compraId: null, transaccionId: plan.accion.transaccionId };
          aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
          this.registrarEnResultadoBulk(resultado, fila, item, plan);
        }
        continue;
      }

      // Ejecución transaccional por sub-lote (chunk de 50)
      try {
        await this.prisma.$transaction(async (tx) => {
          for (const { fila, item } of chunk) {
            const plan = planificar(item, snap, { desde, notificacionId: fila.id });
            const ids = await this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId: fila.id });
            aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
            this.registrarEnResultadoBulk(resultado, fila, item, plan);
          }
        }, BULK_TX_OPTIONS);
      } catch {
        // Fallback por ítem dentro del chunk si algún correo aislado disparó un error de BD
        for (const { fila, item } of chunk) {
          try {
            const plan = planificar(item, snap, { desde, notificacionId: fila.id });
            const ids = await this.prisma.$transaction(
              (tx) => this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId: fila.id }),
              TX_OPTIONS,
            );
            aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
            this.registrarEnResultadoBulk(resultado, fila, item, plan);
          } catch (e) {
            resultado.errores += 1;
            resultado.detalleErrores.push({
              notificacionId: Number(fila.id),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    const elapsed = Math.max(1, Date.now() - t0);
    resultado.tiempoTotalMs = elapsed;
    resultado.velocidadCorreosPorSegundo = Number(((resultado.totalEvaluados / elapsed) * 1000).toFixed(2));
    return resultado;
  }

  private registrarEnResultadoBulk(
    resultado: ResultadoReprocesoBulk,
    fila: NotificacionesCorreo,
    item: ItemNormalizado,
    plan: ReturnType<typeof planificar>,
  ): void {
    resultado.totalEvaluados += 1;
    if (plan.estado === EstadoNotificacionCorreo.CONCILIADO) resultado.conciliados += 1;
    else if (plan.estado === EstadoNotificacionCorreo.DESCARTADO_RECHAZADO) resultado.descartadosRechazados += 1;
    else if (plan.estado === EstadoNotificacionCorreo.IGNORADO) {
      if (plan.vinculo === 'DUPLICADO') resultado.duplicados += 1;
      else resultado.ignorados += 1;
    } else if (plan.estado === EstadoNotificacionCorreo.PENDIENTE) resultado.pendientesRestantes += 1;
    else if (plan.estado === EstadoNotificacionCorreo.ERROR) resultado.errores += 1;

    if (plan.accion.tipo === 'CREAR_COMPRA') resultado.comprasCreadas += 1;
    else if (plan.accion.tipo === 'VINCULAR_COMPRA') resultado.comprasEnlazadas += 1;
    else if (plan.accion.tipo === 'CREAR_TRANSACCION') resultado.transaccionesCreadas += 1;
    else if (plan.accion.tipo === 'VINCULAR_TRANSACCION') resultado.transaccionesEnlazadas += 1;

    const clave =
      plan.accion.tipo === 'CREAR_COMPRA' && plan.motivo === 'compra_creada_desde_plantilla'
        ? 'compras_creadas_con_plantilla'
        : ACCIONES[plan.accion.tipo];
    const nombre =
      plan.accion.tipo === 'NINGUNA'
        ? plan.estado === EstadoNotificacionCorreo.IGNORADO || plan.estado === EstadoNotificacionCorreo.DESCARTADO_RECHAZADO
          ? 'ignorados'
          : plan.estado === EstadoNotificacionCorreo.ERROR
            ? 'con_error'
            : 'siguen_pendientes'
        : clave;

    resultado.acciones[nombre] = (resultado.acciones[nombre] ?? 0) + 1;
    resultado.motivos[plan.motivo] = (resultado.motivos[plan.motivo] ?? 0) + 1;

    if (resultado.muestras.length < MAX_MUESTRAS && plan.accion.tipo !== 'NINGUNA') {
      resultado.muestras.push({
        notificacionId: Number(fila.id),
        fecha: item.fecha,
        comercio: item.comercio ?? null,
        monto: plan.analisis.monto?.toString() ?? null,
        moneda: plan.analisis.moneda,
        accion: nombre,
        motivo: plan.motivo,
        vinculo: plan.vinculo,
      });
    }
  }

  /** Simula (por defecto) o inicia la ejecución en segundo plano. */
  async reprocesar(dto: ReprocesarDto, ownerUserId: bigint): Promise<ResumenReproceso | { jobId: string; total: number }> {
    if (dto.simular !== false) return this.ejecutarReproceso(dto, ownerUserId, true);

    const activo = [...this.trabajos.values()].find((t) => t.ownerUserId === ownerUserId && t.estado === 'EN_CURSO');
    if (activo) throw new ConflictException(`Ya hay un reproceso en curso (${activo.jobId}): ${activo.procesados}/${activo.total}`);

    const trabajo: Trabajo = {
      jobId: randomUUID(),
      ownerUserId,
      estado: 'EN_CURSO',
      total: 0,
      procesados: 0,
      iniciado: new Date(),
      terminado: null,
      resumen: null,
      error: null,
    };
    this.trabajos.set(trabajo.jobId, trabajo);
    this.limpiarAntiguos();
    // Se inicia sin esperar; el avance se publica en `trabajo.procesados`. Se espera solo a conocer el total.
    let listo!: () => void;
    const total = new Promise<void>((resolver) => (listo = resolver));
    void this.ejecutarReproceso(dto, ownerUserId, false, (hecho, cuantos) => {
      trabajo.procesados = hecho;
      trabajo.total = cuantos;
      listo();
    })
      .then((resumen) => {
        trabajo.estado = 'TERMINADO';
        trabajo.resumen = resumen;
      })
      .catch((e: unknown) => {
        trabajo.estado = 'FALLIDO';
        trabajo.error = e instanceof Error ? e.message : String(e);
        this.logger.error(`Reproceso ${trabajo.jobId} falló: ${trabajo.error}`);
      })
      .finally(() => {
        trabajo.terminado = new Date();
        listo();
      });
    await total;
    if (trabajo.estado === 'FALLIDO') throw new Error(trabajo.error ?? 'El reproceso falló');
    return { jobId: trabajo.jobId, total: trabajo.total };
  }

  estado(jobId: string, ownerUserId: bigint): EstadoTrabajo {
    const t = this.trabajos.get(jobId);
    if (!t || t.ownerUserId !== ownerUserId) throw new NotFoundException(`Reproceso ${jobId} no encontrado`);
    const { ownerUserId: _propietario, ...publico } = t;
    void _propietario;
    return publico;
  }

  // ───────────────────────────── núcleo ─────────────────────────────

  private async ejecutarReproceso(
    dto: ReprocesarDto,
    ownerUserId: bigint,
    simular: boolean,
    progreso?: (hecho: number, total: number) => void,
  ): Promise<ResumenReproceso> {
    // 1. Lo que ya se puede deducir de los datos existentes (tarjeta ↔ últimos 4) se aplica primero.
    const aprendizajes = await this.productos.inferirTarjetas(ownerUserId, { aplicar: !simular });

    // 2. Correos por reprocesar
    const todos = await this.prisma.notificacionesCorreo.findMany({
      where: {
        owner_user_id: ownerUserId,
        estado_procesamiento: EstadoNotificacionCorreo.PENDIENTE,
        // Las que ya generaron una compra/transacción esperan la revisión del usuario: no se vuelven a procesar.
        compra_credito_generada_id: null,
        transaccion_generada_id: null,
        ...(dto.ids?.length ? { id: { in: dto.ids.map((i) => BigInt(i)) } } : {}),
      },
      orderBy: [{ fecha_correo: 'asc' }, { id: 'asc' }],
    });
    const filas = dto.motivos?.length ? todos.filter((n) => dto.motivos?.includes(String((n.datos_parseados as Record<string, unknown> | null)?.motivo ?? ''))) : todos;

    const snap = await this.ejecutor.cargarSnapshot(ownerUserId, { desdeFecha: filas[0]?.fecha_correo ?? null });
    // En simulación las tarjetas «aprendidas» aún no están guardadas: se aplican en memoria para que el resultado sea fiel.
    for (const a of aprendizajes) {
      const t = snap.tarjetas.find((x) => x.id === BigInt(a.tarjetaId));
      if (t && !t.ultimos_4_digitos?.includes(a.ultimos4)) t.ultimos_4_digitos = agregarUltimos4(t.ultimos_4_digitos, a.ultimos4);
    }

    let desde: Date | null = null;
    if (dto.desde) {
      desde = construirFechaHora(dto.desde.slice(0, 10), '00:00', snap.offset);
      if (!desde) throw datosInvalidos({ desde: ['desde debe tener formato yyyy-MM-dd'] });
    }

    const resumen: ResumenReproceso = {
      simulado: simular,
      desde: dto.desde ? dto.desde.slice(0, 10) : null,
      evaluados: 0,
      acciones: {},
      motivos: {},
      omitidos: 0,
      errores: [],
      muestras: [],
      aprendizajes,
    };

    const ordenadas = filas
      .map((n) => ({ fila: n, item: this.itemDe(n) }))
      .filter((x): x is { fila: NotificacionesCorreo; item: ItemNormalizado } => {
        if (!x.item) resumen.omitidos += 1;
        return x.item !== null;
      })
      .sort((a, b) => a.fila.fecha_correo.getTime() - b.fila.fecha_correo.getTime() || prioridadRuta(a.item) - prioridadRuta(b.item) || Number(a.fila.id - b.fila.id));

    progreso?.(0, ordenadas.length);
    let virtual = -1n;
    let hechos = 0;

    if (simular) {
      for (const { fila, item } of ordenadas) {
        try {
          const plan = planificar(item, snap, { desde, notificacionId: fila.id });
          let ids = { compraId: null as bigint | null, transaccionId: null as bigint | null };
          if (plan.accion.tipo === 'CREAR_COMPRA') ids = { compraId: virtual--, transaccionId: null };
          else if (plan.accion.tipo === 'CREAR_TRANSACCION') ids = { compraId: null, transaccionId: virtual-- };
          else if (plan.accion.tipo === 'VINCULAR_COMPRA') ids = { compraId: plan.accion.compraId, transaccionId: null };
          else if (plan.accion.tipo === 'VINCULAR_TRANSACCION') ids = { compraId: null, transaccionId: plan.accion.transaccionId };
          aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
          this.registrarEnResumen(resumen, fila, item, plan);
        } catch (e) {
          resumen.errores.push({ notificacionId: Number(fila.id), error: e instanceof Error ? e.message : String(e) });
        }
        hechos += 1;
        if (hechos % 10 === 0 || hechos === ordenadas.length) progreso?.(hechos, ordenadas.length);
      }
      return resumen;
    }

    // Ejecución por sub-lotes (chunks de 50) dentro de transacciones agrupadas
    const chunkSize = Math.min(100, Math.max(10, dto.chunkSize ?? CHUNK_SIZE_DEFAULT));
    for (let i = 0; i < ordenadas.length; i += chunkSize) {
      const chunk = ordenadas.slice(i, i + chunkSize);
      try {
        await this.prisma.$transaction(async (tx) => {
          for (const { fila, item } of chunk) {
            const plan = planificar(item, snap, { desde, notificacionId: fila.id });
            const ids = await this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId: fila.id });
            aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
            this.registrarEnResumen(resumen, fila, item, plan);
          }
        }, BULK_TX_OPTIONS);
        hechos += chunk.length;
        progreso?.(hechos, ordenadas.length);
      } catch {
        for (const { fila, item } of chunk) {
          try {
            const plan = planificar(item, snap, { desde, notificacionId: fila.id });
            const ids = await this.prisma.$transaction((tx) => this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId: fila.id }), TX_OPTIONS);
            aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);
            this.registrarEnResumen(resumen, fila, item, plan);
          } catch (e) {
            resumen.errores.push({ notificacionId: Number(fila.id), error: e instanceof Error ? e.message : String(e) });
          }
          hechos += 1;
          if (hechos % 10 === 0 || hechos === ordenadas.length) progreso?.(hechos, ordenadas.length);
        }
      }
    }
    return resumen;
  }

  private registrarEnResumen(
    resumen: ResumenReproceso,
    fila: NotificacionesCorreo,
    item: ItemNormalizado,
    plan: ReturnType<typeof planificar>,
  ): void {
    resumen.evaluados += 1;
    const clave =
      plan.accion.tipo === 'CREAR_COMPRA' && plan.motivo === 'compra_creada_desde_plantilla'
        ? 'compras_creadas_con_plantilla'
        : ACCIONES[plan.accion.tipo];
    const nombre =
      plan.accion.tipo === 'NINGUNA'
        ? plan.estado === EstadoNotificacionCorreo.IGNORADO || plan.estado === EstadoNotificacionCorreo.DESCARTADO_RECHAZADO
          ? 'ignorados'
          : plan.estado === EstadoNotificacionCorreo.ERROR
            ? 'con_error'
            : 'siguen_pendientes'
        : clave;
    resumen.acciones[nombre] = (resumen.acciones[nombre] ?? 0) + 1;
    resumen.motivos[plan.motivo] = (resumen.motivos[plan.motivo] ?? 0) + 1;
    if (resumen.muestras.length < MAX_MUESTRAS && plan.accion.tipo !== 'NINGUNA') {
      resumen.muestras.push({
        notificacionId: Number(fila.id),
        fecha: item.fecha,
        comercio: item.comercio ?? null,
        monto: plan.analisis.monto?.toString() ?? null,
        moneda: plan.analisis.moneda,
        accion: nombre,
        motivo: plan.motivo,
        vinculo: plan.vinculo,
      });
    }
  }

  /** Reconstruye el ítem del Apps Script a partir de lo guardado (`datos_parseados` + asunto + cuerpo). `null` si no alcanza. */
  private itemDe(n: NotificacionesCorreo): ItemNormalizado | null {
    const d = (n.datos_parseados ?? {}) as Record<string, unknown>;
    const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const fecha = texto(d.fecha);
    const hora = texto(d.hora);
    const tipo = texto(d.tipo);
    const metodo = texto(d.metodo);
    if (!fecha || !hora || !tipo || !metodo) return null;
    const valor = typeof d.valor === 'string' || typeof d.valor === 'number' ? d.valor : typeof d.monto === 'string' || typeof d.monto === 'number' ? d.monto : null;
    return {
      externalMessageId: n.external_message_id,
      fecha,
      hora,
      tipo,
      metodo,
      comercio: texto(d.comercio),
      origenRaw: texto(d.origenRaw),
      valor,
      moneda: d.moneda === 'USD' ? 'USD' : 'COP',
      linkCorreo: texto(d.linkCorreo),
      asunto: n.asunto,
      cuerpoExtraido: n.cuerpo_extraido,
    };
  }

  /**
   * Igual que `itemDe`, pero si el correo llegó por ingesta individual o con `datos_parseados` incompleto,
   * reconstruye `fecha`, `hora`, `tipo` y `metodo` desde `fecha_correo`, `cuerpo_extraido` y `asunto`.
   */
  private itemDeConFallback(n: NotificacionesCorreo): ItemNormalizado | null {
    const directo = this.itemDe(n);
    if (directo) return directo;

    const d = (n.datos_parseados ?? {}) as Record<string, unknown>;
    const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const cuerpo = interpretarCuerpo(n.cuerpo_extraido);
    const esRechazada = cuerpo.rechazada || detectarPatronRechazo([n.asunto, texto(d.comercio), n.cuerpo_extraido]) !== null;

    const localBogota = new Date(n.fecha_correo.getTime() - 5 * 3600_000).toISOString();
    const fecha = texto(d.fecha) ?? localBogota.slice(0, 10);
    const hora = texto(d.hora) ?? localBogota.slice(11, 19);
    const valor =
      typeof d.valor === 'string' || typeof d.valor === 'number'
        ? d.valor
        : typeof d.monto === 'string' || typeof d.monto === 'number'
          ? d.monto
          : n.monto_original?.toString() ?? cuerpo.recibida?.monto ?? cuerpo.enviada?.monto ?? cuerpo.avance?.monto ?? null;

    if (!esRechazada && !cuerpo.informativo && valor === null) return null;

    const instrumento = texto(d.instrumento)?.toUpperCase() === 'TC' ? 'TC' : 'CUENTA';
    const tipo =
      texto(d.tipo) ??
      (cuerpo.pagoTarjeta
        ? 'Pago'
        : cuerpo.recibida
          ? 'Ingreso'
          : cuerpo.enviada
            ? 'Transferencia'
            : cuerpo.avance
              ? 'Avance'
              : 'Compra');
    const metodo =
      texto(d.metodo) ??
      (cuerpo.pagoTarjeta ? 'Pago Tarjeta' : instrumento === 'TC' ? 'Tarjeta Credito' : 'Cuenta Ahorros/Corriente');
    const ultimos4 = texto(d.ultimos_4) ?? n.ultimos_4 ?? cuerpo.ultimos4;
    const origenRaw = texto(d.origenRaw) ?? (ultimos4 ? (instrumento === 'TC' ? `T.Cred *${ultimos4}` : `Cuenta *${ultimos4}`) : null);

    return {
      externalMessageId: n.external_message_id,
      fecha,
      hora,
      tipo,
      metodo,
      comercio: texto(d.comercio) ?? cuerpo.recibida?.contraparte ?? cuerpo.enviada?.contraparte ?? null,
      origenRaw,
      valor,
      moneda: (texto(d.moneda) ?? n.moneda) === 'USD' ? 'USD' : 'COP',
      linkCorreo: texto(d.linkCorreo),
      asunto: n.asunto,
      cuerpoExtraido: n.cuerpo_extraido,
    };
  }

  private limpiarAntiguos(): void {
    const limite = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, t] of this.trabajos) if (t.terminado && t.terminado.getTime() < limite) this.trabajos.delete(id);
  }
}
