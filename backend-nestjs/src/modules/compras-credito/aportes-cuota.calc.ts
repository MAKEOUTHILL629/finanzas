import { Decimal } from '../../config/decimal.config';
import { money } from '../../common/utils/decimal.util';

export type ModalidadAporteCuota = 'TRANSFERIDO_A_MI' | 'PAGADO_DIRECTO_AL_TITULAR' | 'PAGO_PROPIO_AL_TITULAR';

export interface AporteCuotaItem {
  aportantePersonaId: number;
  monto: Decimal;
  modalidad: ModalidadAporteCuota;
  fecha?: string | null;
}

/**
 * Cálculo colaborativo de una cuota (Fase 5):
 *  miAporteBolsilloNeto = valorCuota − Σ aportes de terceros
 *  porEntregarATitular  = valorCuota − Σ directos al titular − Σ pagos propios al titular
 */
export function calcularCuotaColaborativa(valorCuota: Decimal, aportes: AporteCuotaItem[]) {
  const terceros = aportes.filter((a) => a.modalidad !== 'PAGO_PROPIO_AL_TITULAR');
  const totalAportesTerceros = terceros.reduce((acc, a) => acc.plus(a.monto), new Decimal(0));
  const directos = aportes.filter((a) => a.modalidad === 'PAGADO_DIRECTO_AL_TITULAR').reduce((acc, a) => acc.plus(a.monto), new Decimal(0));
  const propios = aportes.filter((a) => a.modalidad === 'PAGO_PROPIO_AL_TITULAR').reduce((acc, a) => acc.plus(a.monto), new Decimal(0));
  const entregado = directos.plus(propios);
  const porEntregar = money(valorCuota.minus(entregado));
  return {
    valorCuota: money(valorCuota),
    totalAportesTerceros: money(totalAportesTerceros),
    miAporteBolsilloNeto: money(valorCuota.minus(totalAportesTerceros)),
    montoPorEntregarATitular: porEntregar.greaterThan(0) ? porEntregar : money(new Decimal(0)),
    entregadoATitular: money(entregado),
    estadoPagoTitular: porEntregar.lessThanOrEqualTo(0) ? 'PAGADA' : entregado.greaterThan(0) ? 'PARCIAL' : 'PENDIENTE',
  };
}
