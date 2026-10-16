import { Decimal } from '../../config/decimal.config';
import { EstadoTransaccion } from '../../common/enums/finance.enums';
import { normalizarComercio } from './comercio.util';
import type { Plan } from './planificador-correos';

/**
 * Fotografía en memoria de lo que el planificador necesita saber del usuario para decidir qué hacer con un correo:
 * productos, personas, compras, transacciones y correos ya procesados. Se carga UNA vez por lote (o por reproceso) y se va
 * actualizando a medida que se ejecutan las decisiones, de modo que los correos siguientes ya «ven» lo creado/enlazado.
 * Así el planificador es una función pura (sin BD) y el reproceso de cientos de correos no hace cientos de consultas.
 */

export interface CuentaSnap {
  id: bigint;
  ultimos_4_digitos: string | null;
  moneda: string;
  es_principal: boolean;
}

export interface TarjetaSnap {
  id: bigint;
  descripcion: string | null;
  franquicia: string | null;
  ultimos_4_digitos: string | null;
  tasa_interes_compra: Decimal | null;
  tasa_interes_avance: Decimal | null;
}

export interface PersonaSnap {
  id: bigint;
  nombre: string | null;
  numero_celular: string | null;
}

export interface ResponsableSnap {
  personaId: bigint;
  porcentaje: Decimal;
  cuotas: number | null;
}

export interface CompraSnap {
  id: bigint;
  tarjetaId: bigint | null;
  /** yyyy-MM-dd */
  fecha: string;
  valorCop: Decimal;
  moneda: 'COP' | 'USD';
  valorOriginal: Decimal | null;
  concepto: string;
  /** `normalizarComercio(concepto)`, calculado a demanda. */
  conceptoNorm?: string;
  cuotas: number;
  interes: Decimal | null;
  /** Ya la reclama un correo (no puede enlazarse a otro). */
  vinculada: boolean;
  responsables: ResponsableSnap[];
}

export interface TransaccionSnap {
  id: bigint;
  tipo: string;
  estado: string;
  cuentaOrigenId: bigint | null;
  cuentaDestinoId: bigint | null;
  tarjetaPagadaId: bigint | null;
  montoCop: Decimal;
  fecha: Date;
  vinculada: boolean;
}

export interface NotificacionSnap {
  id: bigint;
  ultimos4: string | null;
  monto: Decimal | null;
  moneda: string | null;
  fecha: Date;
  comercioNorm: string | null;
  ruta: string | null;
  estado: string;
  compraId: bigint | null;
  transaccionId: bigint | null;
  vinculo: string | null;
}

export interface SnapshotCorreos {
  ownerUserId: bigint;
  cuentas: CuentaSnap[];
  tarjetas: TarjetaSnap[];
  personas: PersonaSnap[];
  /** La persona «yo» (la enlazada al usuario): sus gastos no generan deuda. */
  miPersonaId: bigint | null;
  compras: CompraSnap[];
  transacciones: TransaccionSnap[];
  notificaciones: NotificacionSnap[];
  /** Zona del buzón (por defecto Bogotá). */
  offset: string;
  trmRespaldo: Decimal | null;
  ultimaTrmUsd: Decimal | null;
}

export function conceptoNormalizado(c: CompraSnap): string {
  if (c.conceptoNorm === undefined) c.conceptoNorm = normalizarComercio(c.concepto);
  return c.conceptoNorm;
}

export interface IdsEjecutados {
  notificacionId: bigint;
  compraId?: bigint | null;
  transaccionId?: bigint | null;
}

/**
 * Refleja en la fotografía lo que acaba de hacer una decisión (o lo que haría, en simulación), para que los correos que
 * siguen la vean: la compra queda reclamada, la compra/transacción nueva existe, la notificación queda registrada.
 */
export function aplicarPlanASnapshot(snap: SnapshotCorreos, plan: Plan, ids: IdsEjecutados, fechaCorreo: Date): void {
  const { analisis, accion } = plan;
  let compraId: bigint | null = ids.compraId ?? null;
  let transaccionId: bigint | null = ids.transaccionId ?? null;

  switch (accion.tipo) {
    case 'VINCULAR_COMPRA': {
      const compra = snap.compras.find((c) => c.id === accion.compraId);
      if (compra) compra.vinculada = true;
      compraId = accion.compraId;
      break;
    }
    case 'CREAR_COMPRA': {
      if (compraId !== null) {
        snap.compras.push({
          id: compraId,
          tarjetaId: accion.tarjetaId,
          fecha: accion.fechaCompra.toISOString().slice(0, 10),
          valorCop: accion.valorCop,
          moneda: accion.moneda,
          valorOriginal: accion.moneda === 'USD' ? accion.valorOriginal : null,
          concepto: accion.concepto,
          cuotas: accion.numeroCuotas,
          interes: accion.interes,
          vinculada: true,
          responsables: accion.responsables,
        });
      }
      break;
    }
    case 'VINCULAR_TRANSACCION': {
      const t = snap.transacciones.find((x) => x.id === accion.transaccionId);
      if (t) {
        t.vinculada = true;
        if (accion.completarTarjetaId !== null && t.tarjetaPagadaId === null) t.tarjetaPagadaId = accion.completarTarjetaId;
      }
      transaccionId = accion.transaccionId;
      break;
    }
    case 'CREAR_TRANSACCION': {
      if (transaccionId !== null) {
        const d = accion.datos;
        snap.transacciones.push({
          id: transaccionId,
          tipo: d.tipoTransaccion,
          estado: d.estado ?? EstadoTransaccion.CONFIRMADO,
          cuentaOrigenId: d.cuentaOrigenId === null ? null : BigInt(d.cuentaOrigenId),
          cuentaDestinoId: d.cuentaDestinoId === null ? null : BigInt(d.cuentaDestinoId),
          tarjetaPagadaId: d.tarjetaPagadaId === null ? null : BigInt(d.tarjetaPagadaId),
          montoCop: accion.montoCop,
          fecha: d.fechaTransaccion,
          vinculada: true,
        });
      }
      break;
    }
    default:
      break;
  }

  const previa = snap.notificaciones.find((n) => n.id === ids.notificacionId);
  const nueva: NotificacionSnap = {
    id: ids.notificacionId,
    ultimos4: analisis.ultimos4,
    monto: analisis.monto,
    moneda: analisis.moneda,
    fecha: analisis.fecha ?? fechaCorreo,
    comercioNorm: analisis.comercioNorm || null,
    ruta: analisis.ruta,
    estado: plan.estado,
    compraId,
    transaccionId,
    vinculo: plan.vinculo,
  };
  if (previa) Object.assign(previa, nueva);
  else snap.notificaciones.push(nueva);
}
