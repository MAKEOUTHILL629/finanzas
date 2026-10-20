import { Decimal } from '../../config/decimal.config';
import { money } from '../../common/utils/decimal.util';
import { calcularPartes } from '../cobros/cobro-division.calc';

export interface ParticipanteEvento {
  participanteId: number;
  personaId: number;
  alias: string | null;
  peso: Decimal;
}

export interface GastoEvento {
  descripcion: string;
  montoTotal: Decimal;
  pagadoPorParticipanteId: number;
  tipoDivision: 'PARTES_IGUALES' | 'PESOS_CUPOS' | 'MONTOS_EXACTOS';
  divisionJson?: Record<string, number | string> | null;
}

export interface BalanceParticipante {
  participanteId: number;
  personaId: number;
  alias: string | null;
  totalAportado: Decimal;
  /** «Nos toca $X»: lo que le corresponde asumir del total del evento. */
  leToca: Decimal;
  /** aportado − leToca. Positivo: le deben; negativo: debe. */
  balance: Decimal;
}

export interface TransferenciaSugerida {
  desdePersonaId: number;
  haciaPersonaId: number;
  monto: Decimal;
}

/** Lo que le toca a cada participante de UN gasto, reutilizando la división de cobros. */
export function partesDeGasto(gasto: GastoEvento, participantes: ParticipanteEvento[]): Map<number, Decimal> {
  if (gasto.tipoDivision === 'MONTOS_EXACTOS') {
    const partes = calcularPartes(gasto.montoTotal, 'MONTO', participantes.map((p) => ({ personaId: p.participanteId, monto: gasto.divisionJson?.[String(p.participanteId)] ?? gasto.divisionJson?.[String(p.personaId)] })), null);
    return new Map(partes.map((p) => [p.personaId, p.monto]));
  }
  if (gasto.tipoDivision === 'PESOS_CUPOS') {
    const pesoTotal = participantes.reduce((a, p) => a.plus(p.peso), new Decimal(0));
    const partes = calcularPartes(gasto.montoTotal, 'PORCENTAJE', participantes.map((p) => ({ personaId: p.participanteId, porcentaje: p.peso.mul(100).div(pesoTotal).toString() })), null);
    return new Map(partes.map((p) => [p.personaId, p.monto]));
  }
  const partes = calcularPartes(gasto.montoTotal, 'IGUAL', participantes.map((p) => ({ personaId: p.participanteId })), null);
  return new Map(partes.map((p) => [p.personaId, p.monto]));
}

/** Balances del evento: cuánto puso cada uno, cuánto le toca y su neto. */
export function calcularBalances(participantes: ParticipanteEvento[], gastos: GastoEvento[]): BalanceParticipante[] {
  const aportado = new Map<number, Decimal>(participantes.map((p) => [p.participanteId, new Decimal(0)]));
  const leToca = new Map<number, Decimal>(participantes.map((p) => [p.participanteId, new Decimal(0)]));
  for (const g of gastos) {
    aportado.set(g.pagadoPorParticipanteId, (aportado.get(g.pagadoPorParticipanteId) ?? new Decimal(0)).plus(g.montoTotal));
    for (const [participanteId, monto] of partesDeGasto(g, participantes)) {
      leToca.set(participanteId, (leToca.get(participanteId) ?? new Decimal(0)).plus(monto));
    }
  }
  return participantes.map((p) => {
    const a = money(aportado.get(p.participanteId) ?? new Decimal(0));
    const t = money(leToca.get(p.participanteId) ?? new Decimal(0));
    return { participanteId: p.participanteId, personaId: p.personaId, alias: p.alias, totalAportado: a, leToca: t, balance: money(a.minus(t)) };
  });
}

/** Vector mínimo (greedy) de transferencias «Cruzo Cuentas» para saldar los balances. */
export function transferenciasMinimas(balances: BalanceParticipante[]): TransferenciaSugerida[] {
  const deudores = balances.filter((b) => b.balance.isNegative()).map((b) => ({ personaId: b.personaId, resta: b.balance.abs() })).sort((a, b) => b.resta.comparedTo(a.resta));
  const acreedores = balances.filter((b) => b.balance.greaterThan(0)).map((b) => ({ personaId: b.personaId, resta: b.balance })).sort((a, b) => b.resta.comparedTo(a.resta));
  const resultado: TransferenciaSugerida[] = [];
  let i = 0;
  let j = 0;
  while (i < deudores.length && j < acreedores.length) {
    const monto = Decimal.min(deudores[i].resta, acreedores[j].resta);
    if (monto.greaterThan(0)) resultado.push({ desdePersonaId: deudores[i].personaId, haciaPersonaId: acreedores[j].personaId, monto: money(monto) });
    deudores[i].resta = deudores[i].resta.minus(monto);
    acreedores[j].resta = acreedores[j].resta.minus(monto);
    if (deudores[i].resta.isZero()) i++;
    if (acreedores[j].resta.isZero()) j++;
  }
  return resultado;
}

export function liquidarEvento(participantes: ParticipanteEvento[], gastos: GastoEvento[]) {
  const balances = calcularBalances(participantes, gastos);
  return { balances, transferencias: transferenciasMinimas(balances), totalEvento: money(gastos.reduce((a, g) => a.plus(g.montoTotal), new Decimal(0))) };
}
