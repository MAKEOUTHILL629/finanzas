import { Decimal } from '../../config/decimal.config';
import { money } from '../../common/utils/decimal.util';
import { normalizarComercio } from '../notificaciones-correo/comercio.util';

export type FrecuenciaDetectada = 'MENSUAL' | 'ANUAL' | 'QUINCENAL';
export type TipoMontoDetectado = 'MONTO_FIJO_COP' | 'MONTO_VARIABLE_TRM_O_CONSUMO';

export interface CargoSerie {
  fecha: Date;
  monto: Decimal;
  descripcion: string;
  comercioCanonico?: string | null;
}

export interface CandidatoRecurrente {
  clave: string;
  comercio: string;
  cargos: number;
  frecuencia: FrecuenciaDetectada;
  intervaloMedianoDias: number;
  montoPromedio: Decimal;
  ultimoMonto: Decimal;
  coeficienteVariacion: number;
  tipoMonto: TipoMontoDetectado;
  primeraFecha: Date;
  ultimaFecha: Date;
  proximaFechaEstimada: Date;
  incrementoTarifa: boolean;
  /** Equivalente mensual para KPIs (anual ÷12, quincenal ×2). */
  montoMensualizado: Decimal;
}

const DIA = 86_400_000;

function mediana(valores: number[]): number {
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

export function claveComercio(c: CargoSerie): string {
  return c.comercioCanonico ? normalizarComercio(c.comercioCanonico) : normalizarComercio(c.descripcion);
}

function clasificarFrecuencia(medianaDias: number): FrecuenciaDetectada | null {
  if (medianaDias >= 25 && medianaDias <= 35) return 'MENSUAL';
  if (medianaDias >= 355 && medianaDias <= 375) return 'ANUAL';
  if (medianaDias >= 13 && medianaDias <= 17) return 'QUINCENAL';
  return null;
}

/** Análisis puro de una serie de cargos de un mismo comercio (Fase 3). Null si no hay periodicidad clara. */
export function analizarSerie(clave: string, cargosEntrada: CargoSerie[]): CandidatoRecurrente | null {
  const cargos = [...cargosEntrada].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  if (cargos.length < 2) return null;
  // Deben caer en meses distintos (dos cargos el mismo día no hacen una suscripción).
  const meses = new Set(cargos.map((c) => `${c.fecha.getUTCFullYear()}-${c.fecha.getUTCMonth()}`));
  if (meses.size < 2 && cargos.length < 3) return null;

  const intervalos: number[] = [];
  for (let i = 1; i < cargos.length; i++) intervalos.push(Math.round((cargos[i].fecha.getTime() - cargos[i - 1].fecha.getTime()) / DIA));
  const med = mediana(intervalos);
  const frecuencia = clasificarFrecuencia(med);
  if (!frecuencia) return null;

  const montos = cargos.map((c) => c.monto);
  const media = montos.reduce((a, m) => a.plus(m), new Decimal(0)).div(montos.length);
  if (!media.greaterThan(0)) return null;
  const varianza = montos.reduce((a, m) => a.plus(m.minus(media).pow(2)), new Decimal(0)).div(montos.length);
  const sigma = varianza.sqrt();
  const cv = sigma.div(media).toNumber();
  const tipoMonto: TipoMontoDetectado = cv <= 0.03 ? 'MONTO_FIJO_COP' : cv <= 0.2 ? 'MONTO_VARIABLE_TRM_O_CONSUMO' : 'MONTO_VARIABLE_TRM_O_CONSUMO';
  if (cv > 0.2) return null; // demasiado irregular: no es una suscripción reconocible

  const ultimos3 = montos.slice(-4, -1);
  const promedioPrevio = ultimos3.length ? ultimos3.reduce((a, m) => a.plus(m), new Decimal(0)).div(ultimos3.length) : media;
  const ultimo = montos[montos.length - 1];
  const incrementoTarifa = promedioPrevio.greaterThan(0) && ultimo.greaterThan(promedioPrevio.mul(1.05));

  const factor = frecuencia === 'ANUAL' ? new Decimal(1).div(12) : frecuencia === 'QUINCENAL' ? new Decimal(2) : new Decimal(1);
  return {
    clave,
    comercio: cargos[cargos.length - 1].comercioCanonico ?? cargos[cargos.length - 1].descripcion,
    cargos: cargos.length,
    frecuencia,
    intervaloMedianoDias: med,
    montoPromedio: money(media),
    ultimoMonto: money(ultimo),
    coeficienteVariacion: Math.round(cv * 10000) / 10000,
    tipoMonto,
    primeraFecha: cargos[0].fecha,
    ultimaFecha: cargos[cargos.length - 1].fecha,
    proximaFechaEstimada: new Date(cargos[cargos.length - 1].fecha.getTime() + med * DIA),
    incrementoTarifa,
    montoMensualizado: money(media.mul(factor)),
  };
}

/** Agrupa cargos por comercio canónico y analiza cada serie. */
export function detectarCandidatos(cargos: CargoSerie[]): CandidatoRecurrente[] {
  const grupos = new Map<string, CargoSerie[]>();
  for (const c of cargos) {
    const clave = claveComercio(c);
    if (!clave) continue;
    grupos.set(clave, [...(grupos.get(clave) ?? []), c]);
  }
  return [...grupos.entries()]
    .map(([clave, serie]) => analizarSerie(clave, serie))
    .filter((x): x is CandidatoRecurrente => x !== null)
    .sort((a, b) => b.montoMensualizado.comparedTo(a.montoMensualizado));
}
