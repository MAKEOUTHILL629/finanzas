import { Decimal } from '../../config/decimal.config';
import { EstadoNotificacionCorreo, EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, rate } from '../../common/utils/decimal.util';
import type { DatosTransaccion } from '../transacciones/transacciones.service';
import {
  construirFechaHora,
  decidirRuta,
  detectarInstrumento,
  extraerUltimos4,
  Instrumento,
  motivoIgnorar,
  parseMontoBancolombia,
  resolverCuentaOPrincipal,
  resolverTarjeta,
  RutaSync,
} from './bancolombia-normalizer.util';
import { clasificarIntencionCorreo, generarHuellaSincronizacion, TipoIntencionCorreo } from './clasificador-correo.util';
import { nombreLegibleComercio, normalizarComercio } from './comercio.util';
import { InterpretacionCuerpo, interpretarCuerpo } from './cuerpo-correo.util';
import { buscarCompraVentana36h, buscarTransaccionVentana36h, ConfianzaResolucion, inferirCuentaPorHistorial, inferirTarjetaPorHistorial } from './resolucion-identidad.util';
import { encontrarPersona, nombreContraparte } from './persona-match.util';
import { elegirPlantilla, PlantillaCompra } from './plantilla-compra.util';
import { CompraSnap, NotificacionSnap, ResponsableSnap, SnapshotCorreos, TarjetaSnap } from './snapshot-correos';

/**
 * Planificador de correos: dado un correo ya clasificado por el Apps Script y la fotografía del usuario, decide QUÉ HACER
 * con él, sin tocar la base de datos. Es la «inteligencia» del sync:
 *
 *  • Compra con tarjeta de crédito → primero busca si ya existe esa compra (misma tarjeta, fecha y monto) y la ENLAZA;
 *    si no, la crea con las cuotas y los responsables que el usuario ya usó con ese comercio (plantilla).
 *  • Dos correos del mismo hecho (misma tarjeta/cuenta, monto y minuto) → el segundo se marca DUPLICADO.
 *  • Transferencias (Bre-B, llaves, QR…), retiros y compras débito → transacción en la cuenta que dicen los últimos 4 dígitos;
 *    las que ya existen se enlazan; se reconoce a la persona cuando la contraparte es una de las registradas.
 *  • Lo que no se puede resolver con certeza queda PENDIENTE con el motivo, nunca se inventa.
 */

export interface ItemNormalizado {
  externalMessageId: string;
  fecha: string;
  hora: string;
  tipo: string;
  metodo: string;
  comercio?: string | null;
  origenRaw?: string | null;
  valor?: string | number | null;
  moneda?: 'COP' | 'USD' | null;
  linkCorreo?: string | null;
  asunto?: string | null;
  cuerpoExtraido?: string | null;
  esErrorParsing?: boolean | null;
}

export interface Analisis {
  ruta: RutaSync;
  ultimos4: string | null;
  instrumento: Instrumento;
  moneda: 'COP' | 'USD';
  monto: Decimal | null;
  fecha: Date | null;
  comercioNorm: string;
  cuerpo: InterpretacionCuerpo;
  tarjetaId: bigint | null;
  cuentaId: bigint | null;
  personaId: bigint | null;
  /** Clasificación semántica previa a la ingesta (Fase 1). */
  tipoIntencion: TipoIntencionCorreo;
  tipoEvento: 'PAGO_TARJETA' | 'COMPRA_TC' | 'RECHAZADO' | 'OTRO';
  esCompraValida: boolean;
  patronRechazo?: string | null;
  huella: string;
  confianzaResolucion: ConfianzaResolucion | null;
}

export interface ResumenPlantilla {
  muestras: number;
  confianza: number;
  origen: 'historial' | 'concepto_similar';
}

export type AccionPlan =
  | { tipo: 'NINGUNA' }
  | { tipo: 'DUPLICADO'; originalId: bigint }
  | { tipo: 'VINCULAR_COMPRA'; compraId: bigint }
  | {
      tipo: 'CREAR_COMPRA';
      tarjetaId: bigint;
      concepto: string;
      esAvance: boolean;
      fechaCompra: Date;
      moneda: 'COP' | 'USD';
      valorCop: Decimal;
      valorOriginal: Decimal;
      tasa: Decimal | null;
      numeroCuotas: number;
      interes: Decimal;
      responsables: ResponsableSnap[];
      descripcion: string;
    }
  | { tipo: 'VINCULAR_TRANSACCION'; transaccionId: bigint; completarTarjetaId: bigint | null }
  | { tipo: 'CREAR_TRANSACCION'; datos: DatosTransaccion; montoCop: Decimal; permitirPagoTarjetaSinTarjeta: boolean };

export type Vinculo = 'CREADA' | 'EXISTENTE' | 'DUPLICADO';

export interface Plan {
  analisis: Analisis;
  estado: EstadoNotificacionCorreo;
  motivo: string;
  accion: AccionPlan;
  vinculo: Vinculo | null;
  notificacionOriginalId: bigint | null;
  plantilla: ResumenPlantilla | null;
}

export interface OpcionesPlan {
  /**
   * Fecha de corte para REGISTRAR cosas nuevas: los correos anteriores solo se enlazan a lo que ya existe; si no hay
   * equivalente quedan PENDIENTES (no se llena el historial con compras de hace años sin que el usuario lo pida).
   */
  desde?: Date | null;
  /** Id de la notificación que se está reprocesando (para no compararla consigo misma). */
  notificacionId?: bigint | null;
}

export const VENTANA_PAGO_TARJETA_MS = 5 * 60 * 1000;
export const VENTANA_DUPLICADO_MS = 10 * 60 * 1000;
const MS_DIA = 24 * 60 * 60 * 1000;

const MOTIVO_HISTORICO = 'historico_sin_registro_previo';

// ───────────────────────────── análisis ─────────────────────────────

function minutosDeOffset(offset: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -300;
}

/** Número de día calendario (en la zona del buzón) de un instante: sirve para comparar «el mismo día». */
function diaLocal(fecha: Date, offset: string): number {
  return Math.floor((fecha.getTime() + minutosDeOffset(offset) * 60_000) / MS_DIA);
}

export function analizar(item: ItemNormalizado, snap: SnapshotCorreos): Analisis {
  const cuerpo = interpretarCuerpo(item.cuerpoExtraido);
  const moneda = item.moneda === 'USD' ? 'USD' : 'COP';
  const ultimos4 = extraerUltimos4(item.origenRaw) ?? cuerpo.ultimos4;
  const instrumento = detectarInstrumento(item.origenRaw, item.metodo);
  const clasificacion = clasificarIntencionCorreo([item.asunto, item.comercio, item.cuerpoExtraido, item.tipo]);
  const esRechazada = cuerpo.rechazada || clasificacion.tipoIntencion === 'TRANSACCION_RECHAZADA';
  const ruta: RutaSync = esRechazada ? 'IGNORAR' : decidirRuta({ ...item, tipo: item.tipo, metodo: item.metodo }, cuerpo);
  // El cuerpo y el clasificador multicapa mandan sobre el rótulo: rechazada/pago detectados pisan cualquier compra.
  const tipoIntencion: TipoIntencionCorreo = esRechazada
    ? 'TRANSACCION_RECHAZADA'
    : cuerpo.pagoTarjeta
      ? 'PAGO_ABONO_TARJETA'
      : clasificacion.tipoIntencion;
  const patronRechazo = cuerpo.patronRechazo ?? clasificacion.patronRechazo ?? null;
  const monto = parseMontoBancolombia(item.valor, moneda);
  const fecha = construirFechaHora(item.fecha, item.hora, snap.offset);

  const nombre = cuerpo.recibida?.contraparte ?? cuerpo.enviada?.contraparte ?? nombreContraparte(item.comercio);
  const llave = cuerpo.recibida?.llave ?? cuerpo.enviada?.llave ?? /llave:\s*(\S+?)\)?\s*$/i.exec(item.comercio ?? '')?.[1] ?? null;
  const esMovimientoDeCuenta = ruta === 'INGRESO' || ruta === 'EGRESO';
  const persona = esMovimientoDeCuenta ? encontrarPersona(snap.personas.filter((p) => p.id !== snap.miPersonaId), nombre, llave) : null;
  const comercioNorm = normalizarComercio(ruta === 'COMPRA_TC' ? item.comercio : (nombre ?? item.comercio));

  return {
    ruta,
    ultimos4,
    instrumento,
    moneda,
    monto,
    fecha,
    comercioNorm,
    cuerpo,
    tarjetaId: null,
    cuentaId: null,
    personaId: persona?.id ?? null,
    tipoIntencion,
    tipoEvento: tipoIntencion === 'TRANSACCION_RECHAZADA' ? 'RECHAZADO' : tipoIntencion === 'PAGO_ABONO_TARJETA' ? 'PAGO_TARJETA' : ruta === 'COMPRA_TC' ? 'COMPRA_TC' : 'OTRO',
    esCompraValida: ruta === 'COMPRA_TC' && tipoIntencion !== 'TRANSACCION_RECHAZADA' && tipoIntencion !== 'PAGO_ABONO_TARJETA',
    patronRechazo,
    huella: generarHuellaSincronizacion({
      fecha,
      montoCentavos: monto ? monto.mul(100).toFixed(0) : null,
      ultimos4,
      comercio: comercioNorm,
    }),
    confianzaResolucion: null,
  };
}

// ───────────────────────────── coincidencias ─────────────────────────────

const mismoMonto = (a: Decimal | null, b: Decimal | null): boolean => a !== null && b !== null && a.equals(b);

/**
 * Compra ya registrada que corresponde al correo: misma tarjeta (si se conoce), mismo monto y misma fecha (o ±1 día, por el
 * corte de medianoche del banco), que ningún otro correo haya reclamado. Si la tarjeta del correo no se conoce, solo se
 * enlaza cuando la coincidencia es inequívoca (todas las candidatas son de la misma tarjeta).
 */
export function buscarCompraExistente(
  snap: SnapshotCorreos,
  q: { tarjetaId: bigint | null; fecha: string; monto: Decimal; moneda: 'COP' | 'USD' },
): CompraSnap | null {
  const centro = Date.parse(`${q.fecha}T00:00:00Z`);
  const candidatas = snap.compras
    .filter((c) => {
      if (c.vinculada) return false;
      if (q.tarjetaId !== null && c.tarjetaId !== q.tarjetaId) return false;
      const dias = Math.abs(Date.parse(`${c.fecha}T00:00:00Z`) - centro) / MS_DIA;
      if (dias > 1) return false;
      return q.moneda === 'COP' ? c.moneda === 'COP' && mismoMonto(c.valorCop, q.monto) : c.moneda === 'USD' && mismoMonto(c.valorOriginal, q.monto);
    })
    .map((c) => ({ c, dias: Math.abs(Date.parse(`${c.fecha}T00:00:00Z`) - centro) / MS_DIA }))
    .sort((a, b) => a.dias - b.dias || Number(a.c.id - b.c.id));
  if (candidatas.length === 0) return null;
  if (q.tarjetaId === null && new Set(candidatas.map((x) => x.c.tarjetaId)).size > 1) return null;
  return candidatas[0].c;
}

/** Correo anterior que describe el MISMO hecho (el banco a veces envía dos avisos): misma cuenta/tarjeta, monto y minuto. */
export function buscarNotificacionDuplicada(snap: SnapshotCorreos, a: Analisis, notificacionId: bigint | null): NotificacionSnap | null {
  if (!a.fecha || !a.monto) return null;
  const fecha = a.fecha;
  const candidatas = snap.notificaciones.filter((n) => {
    if (notificacionId !== null && n.id === notificacionId) return false;
    if (n.estado === 'ERROR' || (n.estado === 'IGNORADO' && n.vinculo !== 'DUPLICADO')) return false;
    if (n.ruta !== a.ruta || n.ultimos4 !== a.ultimos4 || n.moneda !== a.moneda || !mismoMonto(n.monto, a.monto)) return false;
    if (Math.abs(n.fecha.getTime() - fecha.getTime()) > VENTANA_DUPLICADO_MS) return false;
    if (n.comercioNorm && a.comercioNorm && n.comercioNorm !== a.comercioNorm) return false;
    // El original es el que se procesó antes: no es posterior al actual (en reproceso, empates por id).
    if (n.fecha.getTime() > fecha.getTime()) return false;
    if (n.fecha.getTime() === fecha.getTime() && notificacionId !== null && n.id > notificacionId) return false;
    return true;
  });
  if (candidatas.length === 0) return null;
  // Se prefiere un original auténtico a otro duplicado; luego el más antiguo.
  return candidatas.sort((x, y) => Number(x.vinculo === 'DUPLICADO') - Number(y.vinculo === 'DUPLICADO') || x.fecha.getTime() - y.fecha.getTime() || Number(x.id - y.id))[0];
}

/** Transacción registrada a mano que corresponde al correo: misma cuenta, monto y día (o ±5 min), sin reclamar. */
export function buscarTransaccionExistente(
  snap: SnapshotCorreos,
  q: { cuentaId: bigint; esIngreso: boolean; montoCop: Decimal; fecha: Date },
): bigint | null {
  const dia = diaLocal(q.fecha, snap.offset);
  const tipo = q.esIngreso ? TipoTransaccion.INGRESO : TipoTransaccion.EGRESO;
  const candidatas = snap.transacciones
    .filter(
      (t) =>
        !t.vinculada &&
        t.estado !== EstadoTransaccion.ANULADO &&
        t.tipo === tipo &&
        (q.esIngreso ? t.cuentaDestinoId === q.cuentaId : t.cuentaOrigenId === q.cuentaId) &&
        t.montoCop.equals(q.montoCop) &&
        (diaLocal(t.fecha, snap.offset) === dia || Math.abs(t.fecha.getTime() - q.fecha.getTime()) <= VENTANA_PAGO_TARJETA_MS),
    )
    .sort((a, b) => Math.abs(a.fecha.getTime() - q.fecha.getTime()) - Math.abs(b.fecha.getTime() - q.fecha.getTime()) || Number(a.id - b.id));
  return candidatas.length > 0 ? candidatas[0].id : null;
}

// ───────────────────────────── planificación ─────────────────────────────

/** "pago tarjeta *1927" / "T.Cred *1927" dentro del cuerpo del correo. */
export function tarjetaEnTexto(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = /(?:t\.?\s*cred|tarjeta(?:\s+de)?\s+cr[eé]dito|tarjeta)[^\d*]{0,20}\*?\s*(?<!\d)(\d{4})(?!\d)/i.exec(texto);
  return m ? m[1] : null;
}

function datosTransaccion(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  p: {
    tipo: TipoTransaccion;
    cuentaId: bigint;
    esOrigen: boolean;
    fecha: Date;
    monto: Decimal;
    moneda: 'COP' | 'USD';
    tasa: Decimal | null;
    tarjetaPagadaId: bigint | null;
    concepto: string;
    contraparte: string | null;
    esTransferenciaInterna?: boolean;
    cuentaContraparteId?: number | null;
  },
): DatosTransaccion {
  return {
    tipoTransaccion: p.tipo,
    cuentaOrigenId: p.esOrigen ? Number(p.cuentaId) : null,
    cuentaDestinoId: p.esOrigen ? null : Number(p.cuentaId),
    tarjetaPagadaId: p.tarjetaPagadaId === null ? null : Number(p.tarjetaPagadaId),
    categoriaId: null,
    fechaTransaccion: p.fecha,
    concepto: p.concepto.slice(0, 255),
    monedaOriginal: p.moneda,
    montoOriginal: p.monto.toString(),
    tasaCambio: p.moneda === 'USD' ? p.tasa?.toString() : undefined,
    origenRegistro: OrigenRegistro.EMAIL_AUTO,
    estado: EstadoTransaccion.CONFIRMADO,
    notas: `Sincronizado desde Bancolombia (${item.externalMessageId})${p.contraparte ? ` · Contraparte: ${p.contraparte}` : ''}`,
    ...(p.esTransferenciaInterna ? { esTransferenciaInterna: true } : {}),
    ...(p.cuentaContraparteId ? { cuentaContraparteId: p.cuentaContraparteId } : {}),
  };
}

export function planificar(item: ItemNormalizado, snap: SnapshotCorreos, opciones: OpcionesPlan = {}): Plan {
  const a = analizar(item, snap);
  const notificacionId = opciones.notificacionId ?? null;
  const plan = (
    estado: EstadoNotificacionCorreo,
    motivo: string,
    accion: AccionPlan = { tipo: 'NINGUNA' },
    extra: Partial<Pick<Plan, 'vinculo' | 'notificacionOriginalId' | 'plantilla'>> = {},
  ): Plan => ({ analisis: a, estado, motivo, accion, vinculo: null, notificacionOriginalId: null, plantilla: null, ...extra });
  const pendiente = (motivo: string) => plan(EstadoNotificacionCorreo.PENDIENTE, motivo);
  const anteriorAlCorte = (fecha: Date) => opciones.desde != null && fecha.getTime() < opciones.desde.getTime();

  // Fase 1 (Bloqueo estricto): cualquier transacción rechazada retorna de inmediato sin crear compras ni transacciones.
  if (a.tipoIntencion === 'TRANSACCION_RECHAZADA' || a.cuerpo.rechazada) {
    a.ruta = 'IGNORAR';
    return plan(EstadoNotificacionCorreo.DESCARTADO_RECHAZADO, 'compra_rechazada_o_no_exitosa', { tipo: 'NINGUNA' });
  }

  if (a.ruta === 'IGNORAR') {
    const motivo = motivoIgnorar(item, a.cuerpo) ?? 'aviso_informativo_o_error_de_parseo';
    if (motivo === 'compra_rechazada_o_no_exitosa') {
      return plan(EstadoNotificacionCorreo.DESCARTADO_RECHAZADO, 'compra_rechazada_o_no_exitosa');
    }
    return plan(EstadoNotificacionCorreo.IGNORADO, motivo);
  }
  // Paso 1 de la cascada: misma huella = mismo hecho ya sincronizado, aunque cambie el ID temporal del lote.
  if (a.huella) {
    const porHuella = snap.notificaciones.find((n) => n.huella === a.huella && (notificacionId === null || n.id !== notificacionId));
    if (porHuella) {
      return plan(
        EstadoNotificacionCorreo.IGNORADO,
        'duplicado_por_huella',
        { tipo: 'DUPLICADO', originalId: porHuella.id },
        { vinculo: 'DUPLICADO', notificacionOriginalId: porHuella.id },
      );
    }
  }
  if (a.ruta === 'SIN_RUTA') return pendiente('tipo_o_metodo_no_reconocido');
  if (!a.fecha) return plan(EstadoNotificacionCorreo.ERROR, 'fecha_u_hora_invalida');
  if (!a.monto || !a.monto.greaterThan(0)) return plan(EstadoNotificacionCorreo.ERROR, 'monto_invalido');
  const fecha = a.fecha;
  const monto = a.monto;

  // TRM para divisas: la de la última compra en USD del usuario, o la de respaldo configurada
  let tasa: Decimal | null = null;
  if (a.moneda === 'USD') {
    tasa = snap.ultimaTrmUsd ?? snap.trmRespaldo;
    if (!tasa) return pendiente('trm_no_disponible');
  }

  if (a.ruta !== 'PAGO_TARJETA') {
    const original = buscarNotificacionDuplicada(snap, a, notificacionId);
    if (original) {
      return plan(EstadoNotificacionCorreo.IGNORADO, 'duplicado_de_correo', { tipo: 'DUPLICADO', originalId: original.id }, {
        vinculo: 'DUPLICADO',
        notificacionOriginalId: original.id,
      });
    }
  }

  switch (a.ruta) {
    case 'COMPRA_TC':
      return planCompraTc(item, snap, a, { fecha, monto, tasa }, plan, pendiente, anteriorAlCorte);
    case 'PAGO_TARJETA':
      return planPagoTarjeta(item, snap, a, { fecha, monto, tasa }, plan, pendiente, anteriorAlCorte);
    case 'INGRESO':
    case 'EGRESO':
      return planMovimientoCuenta(item, snap, a, { fecha, monto, tasa }, plan, pendiente, anteriorAlCorte);
    default:
      return pendiente('ruta_no_soportada');
  }
}

type FabricaPlan = (
  estado: EstadoNotificacionCorreo,
  motivo: string,
  accion?: AccionPlan,
  extra?: Partial<Pick<Plan, 'vinculo' | 'notificacionOriginalId' | 'plantilla'>>,
) => Plan;
type Base = { fecha: Date; monto: Decimal; tasa: Decimal | null };

function planCompraTc(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  a: Analisis,
  b: Base,
  plan: FabricaPlan,
  pendiente: (motivo: string) => Plan,
  anteriorAlCorte: (f: Date) => boolean,
): Plan {
  const tarjeta = resolverTarjeta(snap.tarjetas, a.ultimos4);
  a.tarjetaId = tarjeta?.id ?? null;
  if (tarjeta) a.confianzaResolucion = 'CADENA_PLASTICO';

  const fechaCompra = parseIsoDate(item.fecha);
  if (!fechaCompra) return plan(EstadoNotificacionCorreo.ERROR, 'fecha_invalida');

  // 1. ¿Ya existe esta compra? (registrada a mano o importada antes) → se enlaza, no se duplica.
  const existente = buscarCompraExistente(snap, { tarjetaId: a.tarjetaId, fecha: item.fecha, monto: b.monto, moneda: a.moneda });
  if (existente) {
    a.tarjetaId = a.tarjetaId ?? existente.tarjetaId;
    if (!tarjeta && a.tarjetaId) a.confianzaResolucion = 'EXACTA';
    return plan(EstadoNotificacionCorreo.CONCILIADO, 'vinculada_a_compra_existente', { tipo: 'VINCULAR_COMPRA', compraId: existente.id }, { vinculo: 'EXISTENTE' });
  }

  // 1b. Ventana de ±36 h (Fase 1, paso 4): único huérfano con monto exacto y comercio similar.
  const porVentana = buscarCompraVentana36h(snap, { fecha: b.fecha, monto: b.monto, moneda: a.moneda, comercioNorm: a.comercioNorm, tarjetaId: a.tarjetaId });
  if (porVentana !== null) {
    const compraVentana = snap.compras.find((c) => c.id === porVentana);
    a.tarjetaId = a.tarjetaId ?? compraVentana?.tarjetaId ?? null;
    a.confianzaResolucion = 'VENTANA_36H';
    return plan(EstadoNotificacionCorreo.CONCILIADO, 'vinculada_por_ventana_36h', { tipo: 'VINCULAR_COMPRA', compraId: porVentana }, { vinculo: 'EXISTENTE' });
  }

  // Paso 3: sin últimos 4 (o sin match), el historial del comercio puede pre-asignar la tarjeta (>80 %).
  if (!tarjeta) {
    const inferida = inferirTarjetaPorHistorial(snap, a.comercioNorm);
    if (inferida) {
      a.tarjetaId = inferida.tarjetaId;
      a.confianzaResolucion = 'ALTA_INFERIDA';
      const tarjetaInferida = snap.tarjetas.find((t) => t.id === inferida.tarjetaId);
      if (tarjetaInferida) return planCompraNueva(item, snap, a, b, plan, pendiente, anteriorAlCorte, tarjetaInferida, fechaCompra);
    }
    return pendiente('tarjeta_no_identificada');
  }
  return planCompraNueva(item, snap, a, b, plan, pendiente, anteriorAlCorte, tarjeta, fechaCompra);
}

/** Compra nueva: con los valores que el usuario ya usó con este comercio, si los hay. */
function planCompraNueva(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  a: Analisis,
  b: Base,
  plan: FabricaPlan,
  pendiente: (motivo: string) => Plan,
  anteriorAlCorte: (f: Date) => boolean,
  tarjeta: TarjetaSnap,
  fechaCompra: Date,
): Plan {
  if (anteriorAlCorte(b.fecha)) return pendiente(MOTIVO_HISTORICO);
  const esAvance = item.tipo.trim().toLowerCase() === 'avance';
  const plantilla: PlantillaCompra | null = esAvance ? null : elegirPlantilla(snap, a.comercioNorm);
  const tasaInteres = esAvance ? tarjeta.tasa_interes_avance : tarjeta.tasa_interes_compra;
  const conceptoBase = plantilla
    ? (plantilla.concepto ?? (nombreLegibleComercio(item.comercio) || item.comercio || item.asunto || 'Compra Bancolombia'))
    : (item.comercio ?? item.asunto ?? 'Compra Bancolombia');
  const valorCop = a.moneda === 'COP' ? money(b.monto) : money(b.monto.mul(rate(b.tasa as Decimal)));

  return plan(
    plantilla ? EstadoNotificacionCorreo.CONCILIADO : EstadoNotificacionCorreo.PENDIENTE,
    plantilla ? 'compra_creada_desde_plantilla' : 'compra_tc_creada_a_1_cuota',
    {
      tipo: 'CREAR_COMPRA',
      tarjetaId: tarjeta.id,
      concepto: `${esAvance ? 'Avance - ' : ''}${conceptoBase}`.slice(0, 255),
      esAvance,
      fechaCompra,
      moneda: a.moneda,
      valorCop,
      valorOriginal: b.monto,
      tasa: b.tasa,
      numeroCuotas: plantilla?.numeroCuotas ?? 1,
      interes: plantilla?.interes ?? tasaInteres ?? new Decimal(0),
      responsables: plantilla?.responsables ?? [],
      descripcion: `Importada del correo ${item.linkCorreo ?? item.externalMessageId}`,
    },
    {
      vinculo: 'CREADA',
      plantilla: plantilla ? { muestras: plantilla.muestras, confianza: plantilla.confianza, origen: plantilla.origen } : null,
    },
  );
}

/**
 * Pago de tarjeta: el banco envía dos correos (débito en cuenta y abono en la tarjeta). Si ya existe un PAGO_TARJETA por
 * el mismo monto en una ventana de ±5 min, se enlaza en lugar de duplicar.
 */
function planPagoTarjeta(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  a: Analisis,
  b: Base,
  plan: FabricaPlan,
  pendiente: (motivo: string) => Plan,
  anteriorAlCorte: (f: Date) => boolean,
): Plan {
  const montoCop = a.moneda === 'USD' && b.tasa ? money(b.monto.mul(rate(b.tasa))) : money(b.monto);
  const cuentaOrigen = a.instrumento === 'CUENTA' ? resolverCuentaOPrincipal(snap.cuentas, a.ultimos4) : null;
  // El débito en cuenta trae la tarjeta en el comercio ("Pago TC *1927"); el abono en la tarjeta trae su propio número.
  const ultimos4Tarjeta =
    a.instrumento === 'TC' ? (a.ultimos4 ?? extraerUltimos4(item.comercio)) : (extraerUltimos4(item.comercio) ?? tarjetaEnTexto(item.cuerpoExtraido));
  const tarjeta = resolverTarjeta(snap.tarjetas, ultimos4Tarjeta);
  if (a.instrumento === 'TC' && !a.ultimos4) a.ultimos4 = ultimos4Tarjeta;
  a.cuentaId = cuentaOrigen?.id ?? null;
  a.tarjetaId = tarjeta?.id ?? null;

  const duplicada = snap.transacciones
    .filter(
      (t) =>
        t.tipo === TipoTransaccion.PAGO_TARJETA &&
        t.estado !== EstadoTransaccion.ANULADO &&
        t.montoCop.equals(montoCop) &&
        Math.abs(t.fecha.getTime() - b.fecha.getTime()) <= VENTANA_PAGO_TARJETA_MS,
    )
    .sort((x, y) => Number(x.id - y.id))[0];
  if (duplicada) {
    return plan(
      EstadoNotificacionCorreo.CONCILIADO,
      'duplicado_de_pago_tarjeta_existente',
      { tipo: 'VINCULAR_TRANSACCION', transaccionId: duplicada.id, completarTarjetaId: tarjeta && duplicada.tarjetaPagadaId === null ? tarjeta.id : null },
      { vinculo: 'EXISTENTE' },
    );
  }

  if (!cuentaOrigen) return pendiente('cuenta_origen_no_identificada');
  if (anteriorAlCorte(b.fecha)) return pendiente(MOTIVO_HISTORICO);

  return plan(
    EstadoNotificacionCorreo.CONCILIADO,
    tarjeta ? 'pago_tarjeta_registrado' : 'pago_tarjeta_sin_tarjeta_identificada',
    {
      tipo: 'CREAR_TRANSACCION',
      datos: datosTransaccion(item, snap, {
        tipo: TipoTransaccion.PAGO_TARJETA,
        cuentaId: cuentaOrigen.id,
        esOrigen: true,
        fecha: b.fecha,
        monto: b.monto,
        moneda: a.moneda,
        tasa: b.tasa,
        tarjetaPagadaId: tarjeta?.id ?? null,
        concepto: item.comercio ?? item.asunto ?? `${item.tipo} ${item.metodo}`,
        contraparte: null,
      }),
      montoCop,
      permitirPagoTarjetaSinTarjeta: true,
    },
    { vinculo: 'CREADA' },
  );
}

/** Ingresos y egresos de cuenta: transferencias (Bre-B, llaves, QR, botón), pagos, retiros, compras con débito, nómina. */
function planMovimientoCuenta(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  a: Analisis,
  b: Base,
  plan: FabricaPlan,
  pendiente: (motivo: string) => Plan,
  anteriorAlCorte: (f: Date) => boolean,
): Plan {
  const esIngreso = a.ruta === 'INGRESO';
  const cuenta = resolverCuentaOPrincipal(snap.cuentas, a.ultimos4);
  a.cuentaId = cuenta?.id ?? null;
  const montoCop = a.moneda === 'USD' && b.tasa ? money(b.monto.mul(rate(b.tasa))) : money(b.monto);

  if (cuenta) {
    const existente = buscarTransaccionExistente(snap, { cuentaId: cuenta.id, esIngreso, montoCop, fecha: b.fecha });
    if (existente !== null) {
      a.confianzaResolucion = 'EXACTA';
      return plan(EstadoNotificacionCorreo.CONCILIADO, 'vinculada_a_transaccion_existente', { tipo: 'VINCULAR_TRANSACCION', transaccionId: existente, completarTarjetaId: null }, { vinculo: 'EXISTENTE' });
    }
  }
  // Ventana ±36 h sin exigir cuenta (Fase 1, paso 4).
  const porVentana = buscarTransaccionVentana36h(snap, { fecha: b.fecha, monto: montoCop, comercioNorm: a.comercioNorm });
  if (porVentana !== null) {
    a.confianzaResolucion = 'VENTANA_36H';
    return plan(EstadoNotificacionCorreo.CONCILIADO, 'vinculada_por_ventana_36h', { tipo: 'VINCULAR_TRANSACCION', transaccionId: porVentana, completarTarjetaId: null }, { vinculo: 'EXISTENTE' });
  }
  if (!cuenta) {
    // Paso 3: inferencia por historial del comercio (>80 %).
    const inferida = inferirCuentaPorHistorial(snap, a.comercioNorm);
    const cuentaInferida = inferida ? snap.cuentas.find((c) => c.id === inferida.cuentaId) : undefined;
    if (!cuentaInferida) return pendiente('cuenta_no_identificada');
    a.cuentaId = cuentaInferida.id;
    a.confianzaResolucion = 'ALTA_INFERIDA';
    return planMovimientoConCuenta(item, snap, a, b, plan, pendiente, anteriorAlCorte, cuentaInferida, esIngreso, montoCop);
  }
  return planMovimientoConCuenta(item, snap, a, b, plan, pendiente, anteriorAlCorte, cuenta, esIngreso, montoCop);
}

function planMovimientoConCuenta(
  item: ItemNormalizado,
  snap: SnapshotCorreos,
  a: Analisis,
  b: Base,
  plan: FabricaPlan,
  pendiente: (motivo: string) => Plan,
  anteriorAlCorte: (f: Date) => boolean,
  cuenta: { id: bigint },
  esIngreso: boolean,
  montoCop: Decimal,
): Plan {
  if (anteriorAlCorte(b.fecha)) return pendiente(MOTIVO_HISTORICO);
  const persona = a.personaId === null ? null : snap.personas.find((p) => p.id === a.personaId);
  const contraparte = a.cuerpo.recibida?.contraparte ?? null;

  // Iteración 2 — Fase 4: detectar si es una transferencia entre cuentas propias del mismo usuario
  const digitosDestino = !esIngreso ? extraerUltimos4(item.comercio) : null;
  const cuentaPorDigitosPropia = digitosDestino
    ? snap.cuentas.find((c) => c.id !== cuenta.id && c.ultimos_4_digitos === digitosDestino)
    : undefined;
  const parEnVentana = snap.notificaciones.find(
    (n) =>
      n.cuentaId !== null &&
      n.cuentaId !== undefined &&
      n.cuentaId !== cuenta.id &&
      n.ruta === (esIngreso ? 'EGRESO' : 'INGRESO') &&
      n.monto !== null &&
      n.monto.equals(b.monto) &&
      Math.abs(n.fecha.getTime() - b.fecha.getTime()) <= VENTANA_DUPLICADO_MS,
  );
  const cuentaContrapartePropiaId = cuentaPorDigitosPropia?.id ?? parEnVentana?.cuentaId ?? null;
  const esTransferenciaPropia = cuentaContrapartePropiaId !== null;

  const concepto =
    a.cuerpo.recibida && contraparte
      ? `Transferencia recibida de ${contraparte}`
      : (item.comercio ?? item.asunto ?? `${item.tipo} ${item.metodo}`);

  return plan(
    EstadoNotificacionCorreo.CONCILIADO,
    'transaccion_confirmada_automaticamente',
    {
      tipo: 'CREAR_TRANSACCION',
      datos: datosTransaccion(item, snap, {
        tipo: esIngreso ? TipoTransaccion.INGRESO : TipoTransaccion.EGRESO,
        cuentaId: cuenta.id,
        esOrigen: !esIngreso,
        fecha: b.fecha,
        monto: b.monto,
        moneda: a.moneda,
        tasa: b.tasa,
        tarjetaPagadaId: null,
        concepto,
        contraparte: persona?.nombre ?? null,
        esTransferenciaInterna: esTransferenciaPropia,
        cuentaContraparteId: cuentaContrapartePropiaId !== null ? Number(cuentaContrapartePropiaId) : null,
      }),
      montoCop,
      permitirPagoTarjetaSinTarjeta: false,
    },
    { vinculo: 'CREADA' },
  );
}
