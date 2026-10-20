import { Decimal } from '../src/config/decimal.config';
import { calcularCuotaColaborativa } from '../src/modules/compras-credito/aportes-cuota.calc';

const d = (v: string) => new Decimal(v);

describe('Fase 5 — cuota colaborativa (lavadora en Codensa de Mamá)', () => {
  it('cuota $150.000 con aporte de Hermano $45.000 → mi bolsillo $105.000', () => {
    const r = calcularCuotaColaborativa(d('150000'), [{ aportantePersonaId: 2, monto: d('45000'), modalidad: 'TRANSFERIDO_A_MI' }]);
    expect(r.miAporteBolsilloNeto.toString()).toBe('105000');
    expect(r.totalAportesTerceros.toString()).toBe('45000');
    expect(r.montoPorEntregarATitular.toString()).toBe('150000');
    expect(r.estadoPagoTitular).toBe('PENDIENTE');
  });

  it('aporte directo al titular baja lo por entregar; pago propio completa la cuota', () => {
    const parcial = calcularCuotaColaborativa(d('150000'), [
      { aportantePersonaId: 2, monto: d('45000'), modalidad: 'PAGADO_DIRECTO_AL_TITULAR' },
    ]);
    expect(parcial.montoPorEntregarATitular.toString()).toBe('105000');
    expect(parcial.estadoPagoTitular).toBe('PARCIAL');
    // Lo que me toca de bolsillo sigue siendo cuota − terceros, sin importar la modalidad.
    expect(parcial.miAporteBolsilloNeto.toString()).toBe('105000');

    const pagada = calcularCuotaColaborativa(d('150000'), [
      { aportantePersonaId: 2, monto: d('45000'), modalidad: 'PAGADO_DIRECTO_AL_TITULAR' },
      { aportantePersonaId: 1, monto: d('105000'), modalidad: 'PAGO_PROPIO_AL_TITULAR' },
    ]);
    expect(pagada.montoPorEntregarATitular.toString()).toBe('0');
    expect(pagada.estadoPagoTitular).toBe('PAGADA');
    // Mi pago propio no cuenta como «aporte de terceros».
    expect(pagada.totalAportesTerceros.toString()).toBe('45000');
  });
});
