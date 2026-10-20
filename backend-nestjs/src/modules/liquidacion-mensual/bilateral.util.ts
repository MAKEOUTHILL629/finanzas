import { Decimal } from '../../config/decimal.config';
import { money } from '../../common/utils/decimal.util';

export type ReglaDivision = '50_50' | '100_CONTRAPARTE' | 'PORCENTAJE_CUSTOM' | 'PRORRATA' | 'ABONO' | 'SALDO_ANTERIOR';

export interface ItemBilateral {
  id: number;
  fecha: unknown;
  concepto: string;
  origen: string;
  montoOriginalTotal: Decimal | null;
  reglaDivision: ReglaDivision;
  porcentajeAplicado: Decimal | null;
  montoImputado: Decimal;
}

export interface ItemCrudoLiquidacion {
  id: number;
  fecha: unknown;
  concepto: string;
  origen: string;
  signo: number;
  monto: Decimal;
  detalle?: { valorCompra?: Decimal | null; montoTotal?: Decimal | null; valorCuotaTotal?: Decimal | null; porcentaje?: Decimal | null; modoDivision?: string | null } | null;
}

export function reglaDeItem(item: ItemCrudoLiquidacion): { regla: ReglaDivision; porcentaje: Decimal | null; original: Decimal | null } {
  if (item.signo < 0) return { regla: 'ABONO', porcentaje: null, original: item.monto };
  const pct = item.detalle?.porcentaje ?? null;
  const original = item.detalle?.valorCompra ?? item.detalle?.montoTotal ?? item.detalle?.valorCuotaTotal ?? item.monto;
  if (item.detalle?.modoDivision) return { regla: 'PRORRATA', porcentaje: pct, original };
  if (pct !== null) {
    if (pct.equals(100)) return { regla: '100_CONTRAPARTE', porcentaje: pct, original };
    if (pct.equals(50)) return { regla: '50_50', porcentaje: pct, original };
    return { regla: 'PORCENTAJE_CUSTOM', porcentaje: pct, original };
  }
  return { regla: '100_CONTRAPARTE', porcentaje: new Decimal(100), original };
}

/**
 * Cámara bilateral A vs B (Fase 4): los cargos del sub-ledger van a la columna de la contraparte;
 * abonos y saldos a favor, a la del usuario. El saldo anterior es la fila #1 de quien corresponda.
 * Neto a enviar = (cargos contraparte + saldo anterior contraparte) − (a favor + abonos).
 * Positivo ⇒ la contraparte te envía a ti; negativo ⇒ tú le envías a ella.
 */
export function construirBilateral(p: { saldoAnterior: Decimal; items: ItemCrudoLiquidacion[] }) {
  const columnaContraparte: ItemBilateral[] = [];
  const columnaUsuario: ItemBilateral[] = [];
  const saldo = money(p.saldoAnterior);
  if (!saldo.isZero()) {
    const fila: ItemBilateral = {
      id: 0,
      fecha: null,
      concepto: 'Saldo Anterior',
      origen: 'SALDO_ANTERIOR',
      montoOriginalTotal: saldo.abs(),
      reglaDivision: 'SALDO_ANTERIOR',
      porcentajeAplicado: null,
      montoImputado: saldo.abs(),
    };
    (saldo.greaterThan(0) ? columnaContraparte : columnaUsuario).push(fila);
  }
  for (const item of p.items) {
    const { regla, porcentaje, original } = reglaDeItem(item);
    const fila: ItemBilateral = {
      id: item.id,
      fecha: item.fecha,
      concepto: item.concepto,
      origen: item.origen,
      montoOriginalTotal: original,
      reglaDivision: regla,
      porcentajeAplicado: porcentaje,
      montoImputado: money(item.monto),
    };
    (item.signo > 0 ? columnaContraparte : columnaUsuario).push(fila);
  }
  const sum = (xs: ItemBilateral[]) => money(xs.reduce((a, x) => a.plus(x.montoImputado), new Decimal(0)));
  const totalContraparte = sum(columnaContraparte);
  const totalUsuario = sum(columnaUsuario);
  const netoAEnviar = money(totalContraparte.minus(totalUsuario));
  return {
    columnaUsuario,
    columnaContraparte,
    subtotalContraparte: totalContraparte,
    subtotalUsuario: totalUsuario,
    saldoAnterior: saldo,
    netoAEnviar,
    direccionNeto: netoAEnviar.greaterThan(0) ? 'CONTRAPARTE_ENVIA_A_USUARIO' : netoAEnviar.isNegative() ? 'USUARIO_ENVIA_A_CONTRAPARTE' : 'PAZ_Y_SALVO',
  };
}
