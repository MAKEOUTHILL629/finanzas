import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { EstadoPeriodoAporte, MetodoAporte } from '../../common/enums/finance.enums';
import { money, toDecimal } from '../../common/utils/decimal.util';

/**
 * Matemática de los aportes del carro (sección 3.1 de la especificación). Funciones puras, solo `Decimal`:
 *
 *   Total abonado_m = Σ aportes imputados al mes m (incluye los aportes con método SALDO_A_FAVOR que traen el excedente de otro mes)
 *   Balance_m       = Total abonado_m − Cuota_m
 *   Balance < 0  → saldo pendiente |Balance|             (PENDIENTE si no se abonó nada, PARCIAL si hay algo)
 *   Balance = 0  → COMPLETADO
 *   Balance > 0  → saldo a favor generado = Balance      (CON_SALDO_A_FAVOR mientras quede parte sin aplicar)
 */

export type MetodoCanonico = 'EFECTIVO' | 'TRANSFERENCIA' | 'CRUCE_CUENTAS' | 'SALDO_A_FAVOR' | 'OTRO';

const COMO_EFECTIVO = new Set<string>([MetodoAporte.EFECTIVO, MetodoAporte.FISICO]);
const COMO_TRANSFERENCIA = new Set<string>([MetodoAporte.TRANSFERENCIA, MetodoAporte.BANCOLOMBIA, MetodoAporte.NEQUI]);
const COMO_CRUCE = new Set<string>([MetodoAporte.CRUCE_CUENTAS, MetodoAporte.PRESTAMO]);

/** Agrupa los métodos canónicos y los heredados de AppSheet (`Fisico`, `Bancolombia`, `Nequi`, `Prestamo`…). */
export function clasificarMetodo(metodo: string): MetodoCanonico {
  if (COMO_EFECTIVO.has(metodo)) return 'EFECTIVO';
  if (COMO_TRANSFERENCIA.has(metodo)) return 'TRANSFERENCIA';
  if (COMO_CRUCE.has(metodo)) return 'CRUCE_CUENTAS';
  if (metodo === MetodoAporte.SALDO_A_FAVOR) return 'SALDO_A_FAVOR';
  return 'OTRO';
}

export interface DetalleMedioPago {
  valor: ValorEntrada;
  /** Clasificación binaria Fase 6 (sql/019); si falta se deriva del método canónico. */
  medioPago?: string | null;
  metodoCanonico?: MetodoCanonico;
  metodo?: string;
  personaId?: bigint | number | null;
  personaNombre?: string | null;
}

export interface ResumenMediosPago {
  /** Suma exacta de los aportes en efectivo físico del periodo. */
  totalAportesEfectivo: Decimal;
  /** Suma exacta de los aportes que entraron por transferencia a una cuenta. */
  totalAportesTransferencia: Decimal;
  /** Cuántas transferencias están vinculadas a una transacción bancaria (conciliadas). */
  transferenciasConciliadas: number;
  resumenPorPersona: Array<{
    personaId: number | null;
    nombre: string | null;
    aportadoEfectivo: Decimal;
    aportadoTransferencia: Decimal;
    total: Decimal;
  }>;
}

/** Desglose Fase 6: cuánto del recaudo es efectivo físico y cuánto entró por transferencia, en total y por aportante. */
export function resumenMediosPago(detalles: ReadonlyArray<DetalleMedioPago & { transaccionId?: bigint | number | null }>): ResumenMediosPago {
  let efectivo = new Decimal(0);
  let transferencia = new Decimal(0);
  let conciliadas = 0;
  const porPersona = new Map<string, { personaId: number | null; nombre: string | null; efectivo: Decimal; transferencia: Decimal }>();
  for (const d of detalles) {
    const medio = d.medioPago ?? (d.metodoCanonico ?? (d.metodo ? clasificarMetodo(d.metodo) : 'EFECTIVO'));
    if (medio !== 'EFECTIVO' && medio !== 'TRANSFERENCIA') continue;
    const valor = toDecimal(d.valor);
    if (medio === 'EFECTIVO') efectivo = efectivo.plus(valor);
    else {
      transferencia = transferencia.plus(valor);
      if (d.transaccionId !== null && d.transaccionId !== undefined) conciliadas++;
    }
    const clave = String(d.personaId ?? d.personaNombre ?? '—');
    const fila = porPersona.get(clave) ?? {
      personaId: d.personaId === null || d.personaId === undefined ? null : Number(d.personaId),
      nombre: d.personaNombre ?? null,
      efectivo: new Decimal(0),
      transferencia: new Decimal(0),
    };
    if (medio === 'EFECTIVO') fila.efectivo = fila.efectivo.plus(valor);
    else fila.transferencia = fila.transferencia.plus(valor);
    porPersona.set(clave, fila);
  }
  return {
    totalAportesEfectivo: money(efectivo),
    totalAportesTransferencia: money(transferencia),
    transferenciasConciliadas: conciliadas,
    resumenPorPersona: [...porPersona.values()]
      .map((f) => ({
        personaId: f.personaId,
        nombre: f.nombre,
        aportadoEfectivo: money(f.efectivo),
        aportadoTransferencia: money(f.transferencia),
        total: money(f.efectivo.plus(f.transferencia)),
      }))
      .sort((a, b) => b.total.comparedTo(a.total)),
  };
}

export interface EstadoPeriodoCalculado {
  valorCuotaObjetivo: Decimal;
  montoAbonado: Decimal;
  saldoPendiente: Decimal;
  saldoAFavorGenerado: Decimal;
  saldoAFavorAplicado: Decimal;
  saldoAFavorDisponible: Decimal;
  estado: EstadoPeriodoAporte;
  /** 0–100 (tope 100) para la barra de progreso. */
  progresoPorcentaje: number;
}

type ValorEntrada = Prisma.Decimal | Decimal | string | number;

export function calcularEstadoPeriodo(meta: ValorEntrada, valores: ValorEntrada[], aplicado: ValorEntrada = 0): EstadoPeriodoCalculado {
  const cuota = money(toDecimal(meta));
  const abonado = money(valores.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0)));
  const balance = abonado.minus(cuota);

  const generado = balance.greaterThan(0) ? money(balance) : new Decimal(0);
  // Lo aplicado nunca supera lo generado (si se borran aportes del mes, el excedente baja y lo aplicado se recorta).
  const aplicadoEfectivo = money(Decimal.min(toDecimal(aplicado), generado));
  const disponible = money(generado.minus(aplicadoEfectivo));
  const pendiente = balance.isNegative() ? money(balance.abs()) : new Decimal(0);

  let estado: EstadoPeriodoAporte;
  if (balance.isNegative()) estado = abonado.isZero() ? EstadoPeriodoAporte.PENDIENTE : EstadoPeriodoAporte.PARCIAL;
  else if (balance.isZero()) estado = EstadoPeriodoAporte.COMPLETADO;
  else estado = disponible.greaterThan(0) ? EstadoPeriodoAporte.CON_SALDO_A_FAVOR : EstadoPeriodoAporte.COMPLETADO;

  const progreso = cuota.greaterThan(0) ? Math.min(100, abonado.dividedBy(cuota).times(100).toDecimalPlaces(1).toNumber()) : 100;

  return {
    valorCuotaObjetivo: cuota,
    montoAbonado: abonado,
    saldoPendiente: pendiente,
    saldoAFavorGenerado: generado,
    saldoAFavorAplicado: aplicadoEfectivo,
    saldoAFavorDisponible: disponible,
    estado,
    progresoPorcentaje: progreso,
  };
}
