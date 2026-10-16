import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificacionesCorreo } from '@prisma/client';
import { EstadoNotificacionCorreo } from '../../common/enums/finance.enums';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { construirFechaHora, prioridadRuta } from './bancolombia-normalizer.util';
import { ReprocesarDto } from './dto/productos-correo.dto';
import { EjecutorCorreosService } from './ejecutor-correos.service';
import { ItemNormalizado, planificar } from './planificador-correos';
import { agregarUltimos4, AprendizajeTarjeta, ProductosCorreoService } from './productos-correo.service';
import { aplicarPlanASnapshot } from './snapshot-correos';

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
 *
 * La simulación decide exactamente igual que la ejecución pero no escribe nada. La ejecución corre en segundo plano (puede
 * ser cientos de correos) y se consulta por `jobId`; si se interrumpe, lo ya hecho queda y el resto sigue PENDIENTE.
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
    for (const { fila, item } of ordenadas) {
      try {
        const plan = planificar(item, snap, { desde, notificacionId: fila.id });
        let ids = { compraId: null as bigint | null, transaccionId: null as bigint | null };
        if (simular) {
          if (plan.accion.tipo === 'CREAR_COMPRA') ids = { compraId: virtual--, transaccionId: null };
          else if (plan.accion.tipo === 'CREAR_TRANSACCION') ids = { compraId: null, transaccionId: virtual-- };
          else if (plan.accion.tipo === 'VINCULAR_COMPRA') ids = { compraId: plan.accion.compraId, transaccionId: null };
          else if (plan.accion.tipo === 'VINCULAR_TRANSACCION') ids = { compraId: null, transaccionId: plan.accion.transaccionId };
        } else {
          ids = await this.prisma.$transaction((tx) => this.ejecutor.aplicar(tx, { item, plan, ownerUserId, notificacionId: fila.id }), TX_OPTIONS);
        }
        aplicarPlanASnapshot(snap, plan, { notificacionId: fila.id, ...ids }, fila.fecha_correo);

        resumen.evaluados += 1;
        const clave = plan.accion.tipo === 'CREAR_COMPRA' && plan.motivo === 'compra_creada_desde_plantilla' ? 'compras_creadas_con_plantilla' : ACCIONES[plan.accion.tipo];
        const nombre = plan.accion.tipo === 'NINGUNA' ? (plan.estado === EstadoNotificacionCorreo.IGNORADO ? 'ignorados' : plan.estado === EstadoNotificacionCorreo.ERROR ? 'con_error' : 'siguen_pendientes') : clave;
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
      } catch (e) {
        resumen.errores.push({ notificacionId: Number(fila.id), error: e instanceof Error ? e.message : String(e) });
      }
      hechos += 1;
      if (hechos % 10 === 0 || hechos === ordenadas.length) progreso?.(hechos, ordenadas.length);
    }
    return resumen;
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

  private limpiarAntiguos(): void {
    const limite = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, t] of this.trabajos) if (t.terminado && t.terminado.getTime() < limite) this.trabajos.delete(id);
  }
}
