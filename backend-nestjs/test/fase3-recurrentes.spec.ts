import { Decimal } from '../src/config/decimal.config';
import { analizarSerie, detectarCandidatos } from '../src/modules/gastos-recurrentes/detector-recurrentes.util';

const cargo = (fecha: string, monto: string, descripcion = 'CHATGPT PLUS') => ({ fecha: new Date(fecha), monto: new Decimal(monto), descripcion });

describe('Fase 3 — detector de pagos recurrentes', () => {
  it('3 cobros mensuales con variación del 4 % (TRM) → mensual variable', () => {
    const c = analizarSerie('chatgpt plus', [cargo('2026-08-15', '80000'), cargo('2026-09-15', '83200'), cargo('2026-10-15', '86400')]);
    expect(c).not.toBeNull();
    expect(c?.frecuencia).toBe('MENSUAL');
    expect(c?.tipoMonto).toBe('MONTO_VARIABLE_TRM_O_CONSUMO');
    expect(c?.proximaFechaEstimada.toISOString().slice(0, 10)).toBe('2026-11-14');
  });

  it('monto idéntico cada mes → MONTO_FIJO_COP; anual y quincenal se clasifican', () => {
    const fijo = analizarSerie('spotify', [cargo('2026-08-10', '16900', 'SPOTIFY'), cargo('2026-09-10', '16900', 'SPOTIFY'), cargo('2026-10-10', '16900', 'SPOTIFY')]);
    expect(fijo?.tipoMonto).toBe('MONTO_FIJO_COP');
    const anual = analizarSerie('dominio', [cargo('2024-03-01', '120000', 'DOMINIO'), cargo('2025-03-01', '120000', 'DOMINIO'), cargo('2026-03-01', '126000', 'DOMINIO')]);
    expect(anual?.frecuencia).toBe('ANUAL');
    expect(anual?.montoMensualizado.toString()).toBe('10166.67');
    const quincenal = analizarSerie('gym', [cargo('2026-09-01', '50000', 'GYM'), cargo('2026-09-16', '50000', 'GYM'), cargo('2026-10-01', '50000', 'GYM'), cargo('2026-10-16', '50000', 'GYM')]);
    expect(quincenal?.frecuencia).toBe('QUINCENAL');
  });

  it('incremento de tarifa >5 % sobre el promedio previo se marca', () => {
    const c = analizarSerie('netflix', [cargo('2026-07-01', '30000', 'NETFLIX'), cargo('2026-08-01', '30000', 'NETFLIX'), cargo('2026-09-01', '30000', 'NETFLIX'), cargo('2026-10-01', '33000', 'NETFLIX')]);
    expect(c?.incrementoTarifa).toBe(true);
  });

  it('cargos irregulares o únicos no son suscripciones', () => {
    expect(analizarSerie('x', [cargo('2026-01-01', '10000', 'X')])).toBeNull();
    expect(detectarCandidatos([cargo('2026-01-05', '10000', 'TIENDA'), cargo('2026-03-20', '99999', 'TIENDA'), cargo('2026-08-11', '5000', 'TIENDA')])).toEqual([]);
  });
});
