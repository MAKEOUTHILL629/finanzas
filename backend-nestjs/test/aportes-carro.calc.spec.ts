import { EstadoPeriodoAporte, MetodoAporte } from '../src/common/enums/finance.enums';
import { addMesesPeriodo, mesesEntre, nombrePeriodo, primerDiaPeriodo, ultimoDiaPeriodo } from '../src/common/utils/periodo.util';
import { categoriaDeMovimiento, origenDeMovimiento } from '../src/modules/liquidacion-mensual/liquidacion-mensual.service';
import { calcularEstadoPeriodo, clasificarMetodo, resumenMediosPago } from '../src/modules/obligaciones-aportes/aportes-carro.calc';
import { calcularMesFin } from '../src/modules/recurrentes-persona/recurrentes-persona.service';

describe('resumenMediosPago (Iteración 3 · Fase 6: efectivo vs. transferencia)', () => {
  it('separa efectivo físico de transferencia, cuenta las conciliadas y desglosa por aportante', () => {
    const r = resumenMediosPago([
      { valor: '200000', medioPago: 'EFECTIVO', personaId: 1n, personaNombre: 'Papá', transaccionId: null },
      { valor: '150000.50', medioPago: 'TRANSFERENCIA', personaId: 1n, personaNombre: 'Papá', transaccionId: 77n },
      { valor: '100000', medioPago: 'TRANSFERENCIA', personaId: 2n, personaNombre: 'Hijo', transaccionId: null },
      { valor: '50000', metodo: 'CRUCE_CUENTAS', personaId: 2n, personaNombre: 'Hijo', transaccionId: null },
    ]);
    expect(r.totalAportesEfectivo.toString()).toBe('200000');
    expect(r.totalAportesTransferencia.toString()).toBe('250000.5');
    expect(r.transferenciasConciliadas).toBe(1);
    expect(r.resumenPorPersona.map((p) => [p.nombre, p.aportadoEfectivo.toString(), p.aportadoTransferencia.toString()])).toEqual([
      ['Papá', '200000', '150000.5'],
      ['Hijo', '0', '100000'],
    ]);
  });

  it('sin medioPago deriva del método heredado (Nequi/Bancolombia = transferencia, Fisico = efectivo)', () => {
    const r = resumenMediosPago([
      { valor: 100, metodo: 'Nequi', personaNombre: 'A' },
      { valor: 50, metodo: 'Fisico', personaNombre: 'A' },
    ]);
    expect(r.totalAportesTransferencia.toString()).toBe('100');
    expect(r.totalAportesEfectivo.toString()).toBe('50');
  });
});

describe('calcularEstadoPeriodo (sección 3.1 de la especificación)', () => {
  it('sin aportes → PENDIENTE: debe toda la cuota', () => {
    const r = calcularEstadoPeriodo('1400000', []);
    expect(r.estado).toBe(EstadoPeriodoAporte.PENDIENTE);
    expect(r.montoAbonado.toString()).toBe('0');
    expect(r.saldoPendiente.toString()).toBe('1400000');
    expect(r.saldoAFavorDisponible.toString()).toBe('0');
    expect(r.progresoPorcentaje).toBe(0);
  });

  it('aportes parciales → PARCIAL con el pendiente exacto (Decimal, sin errores de coma flotante)', () => {
    const r = calcularEstadoPeriodo('1810000', ['358000.10', '0.20', '100000']);
    expect(r.estado).toBe(EstadoPeriodoAporte.PARCIAL);
    expect(r.montoAbonado.toString()).toBe('458000.3');
    expect(r.saldoPendiente.toString()).toBe('1351999.7');
    expect(r.progresoPorcentaje).toBe(25.3);
  });

  it('aportes = cuota → COMPLETADO y sin saldo a favor', () => {
    const r = calcularEstadoPeriodo('1000000', ['600000', '400000']);
    expect(r.estado).toBe(EstadoPeriodoAporte.COMPLETADO);
    expect(r.saldoPendiente.toString()).toBe('0');
    expect(r.saldoAFavorGenerado.toString()).toBe('0');
    expect(r.progresoPorcentaje).toBe(100);
  });

  it('aportes > cuota → CON_SALDO_A_FAVOR por el excedente exacto', () => {
    const r = calcularEstadoPeriodo('1000000', ['1000000', '234567.89']);
    expect(r.estado).toBe(EstadoPeriodoAporte.CON_SALDO_A_FAVOR);
    expect(r.saldoAFavorGenerado.toString()).toBe('234567.89');
    expect(r.saldoAFavorDisponible.toString()).toBe('234567.89');
    expect(r.saldoPendiente.toString()).toBe('0');
    expect(r.progresoPorcentaje).toBe(100); // tope de la barra
  });

  it('el saldo a favor aplicado lo descuenta; al aplicarlo todo el periodo queda COMPLETADO', () => {
    expect(calcularEstadoPeriodo('1000000', ['1300000'], '100000').saldoAFavorDisponible.toString()).toBe('200000');
    const todo = calcularEstadoPeriodo('1000000', ['1300000'], '300000');
    expect(todo.saldoAFavorDisponible.toString()).toBe('0');
    expect(todo.estado).toBe(EstadoPeriodoAporte.COMPLETADO);
  });

  it('si se borran aportes, lo aplicado se recorta al excedente que queda (nunca disponible negativo)', () => {
    const r = calcularEstadoPeriodo('1000000', ['1100000'], '300000');
    expect(r.saldoAFavorAplicado.toString()).toBe('100000');
    expect(r.saldoAFavorDisponible.toString()).toBe('0');
  });

  it('un aporte SALDO_A_FAVOR recibido de otro mes cuenta como abono (Total abonado = S(m−1) + Σ aportes)', () => {
    const r = calcularEstadoPeriodo('1000000', ['150000', '850000']);
    expect(r.estado).toBe(EstadoPeriodoAporte.COMPLETADO);
  });
});

describe('clasificarMetodo', () => {
  it('agrupa los métodos canónicos y los heredados de AppSheet', () => {
    expect(clasificarMetodo(MetodoAporte.EFECTIVO)).toBe('EFECTIVO');
    expect(clasificarMetodo('Fisico')).toBe('EFECTIVO');
    expect(clasificarMetodo(MetodoAporte.TRANSFERENCIA)).toBe('TRANSFERENCIA');
    expect(clasificarMetodo('Bancolombia')).toBe('TRANSFERENCIA');
    expect(clasificarMetodo('Nequi')).toBe('TRANSFERENCIA');
    expect(clasificarMetodo(MetodoAporte.CRUCE_CUENTAS)).toBe('CRUCE_CUENTAS');
    expect(clasificarMetodo('Prestamo')).toBe('CRUCE_CUENTAS');
    expect(clasificarMetodo(MetodoAporte.SALDO_A_FAVOR)).toBe('SALDO_A_FAVOR');
    for (const otro of ['Carrera', 'Uso Carro', 'Pago Mensual', 'Otro']) expect(clasificarMetodo(otro)).toBe('OTRO');
  });
});

describe('aritmética de periodos', () => {
  it('suma meses cruzando años y en ambos sentidos', () => {
    expect(addMesesPeriodo('2026-11', 3)).toBe('2027-02');
    expect(addMesesPeriodo('2026-01', -1)).toBe('2025-12');
    expect(addMesesPeriodo('2026-10', 0)).toBe('2026-10');
    expect(addMesesPeriodo('2026-12', 25)).toBe('2029-01');
  });
  it('meses entre dos periodos', () => {
    expect(mesesEntre('2026-10', '2027-01')).toBe(3);
    expect(mesesEntre('2027-01', '2026-10')).toBe(-3);
  });
  it('etiqueta, primer y último día', () => {
    expect(nombrePeriodo('2026-09')).toBe('Septiembre 2026');
    expect(primerDiaPeriodo('2026-02').toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(ultimoDiaPeriodo('2028-02').toISOString()).toBe('2028-02-29T00:00:00.000Z'); // bisiesto
    expect(ultimoDiaPeriodo('2026-12').toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
  it('rechaza periodos inválidos', () => {
    expect(() => addMesesPeriodo('2026-13', 1)).toThrow();
    expect(() => nombrePeriodo('septiembre')).toThrow();
  });
});

describe('calcularMesFin (recurrentes por persona)', () => {
  it('plazo fijo: mes inicio + (X − 1) meses; indefinido: sin fin', () => {
    expect(calcularMesFin('PLAZO_FIJO', '2026-10', 6)).toBe('2027-03');
    expect(calcularMesFin('PLAZO_FIJO', '2026-10', 1)).toBe('2026-10');
    expect(calcularMesFin('INDEFINIDO', '2026-10', null)).toBeNull();
  });
});

describe('liquidación: categoría y origen de cada asiento', () => {
  it('cada tipo de movimiento cae en su bloque', () => {
    expect(categoriaDeMovimiento('CARGO_CUOTA_TC', 1)).toBe('cuotasTarjetas');
    expect(categoriaDeMovimiento('CARGO_PRESTAMO_DIRECTO', 1)).toBe('cuotasPrestamos');
    expect(categoriaDeMovimiento('CARGO_GASTO_COMPARTIDO', 1)).toBe('cargosRecurrentes');
    expect(categoriaDeMovimiento('CARGO_RECURRENTE_PERSONA', 1)).toBe('cargosRecurrentes');
    expect(categoriaDeMovimiento('ABONO_RECURRENTE_PERSONA', -1)).toBe('cargosRecurrentes');
    expect(categoriaDeMovimiento('CARGO_CRUCE_DEUDA', 1)).toBe('crucesCuentas');
    expect(categoriaDeMovimiento('ABONO_CRUCE_DEUDA', -1)).toBe('crucesCuentas');
    expect(categoriaDeMovimiento('ABONO_SALDO_FAVOR_CARRO', -1)).toBe('saldoAFavorAplicado');
    expect(categoriaDeMovimiento('ABONO_PAGO_RECIBIDO', -1)).toBe('abonosRealizados');
  });
  it('un tipo desconocido no se pierde: abono → abonos; cargo → otros', () => {
    expect(categoriaDeMovimiento('LO_QUE_SEA', -1)).toBe('abonosRealizados');
    expect(categoriaDeMovimiento('LO_QUE_SEA', 1)).toBe('otros');
  });
  it('un cargo de cruce con préstamo originado en un aporte es CRUCE_APORTE_CARRO; con CrucesDeuda, CRUCE_ENTRE_PERSONAS', () => {
    expect(origenDeMovimiento({ tipo_movimiento: 'CARGO_CRUCE_DEUDA', cruce_deuda_id: null, prestamo: { origen_cruce_aporte_id: 7n } })).toBe('CRUCE_APORTE_CARRO');
    expect(origenDeMovimiento({ tipo_movimiento: 'CARGO_CRUCE_DEUDA', cruce_deuda_id: 3n, prestamo: null })).toBe('CRUCE_ENTRE_PERSONAS');
    expect(origenDeMovimiento({ tipo_movimiento: 'CARGO_CRUCE_DEUDA', cruce_deuda_id: null, prestamo: { origen_cruce_aporte_id: null } })).toBe('PRESTAMO');
    expect(origenDeMovimiento({ tipo_movimiento: 'ABONO_CRUCE_DEUDA', cruce_deuda_id: 3n })).toBe('CRUCE_ENTRE_PERSONAS');
    expect(origenDeMovimiento({ tipo_movimiento: 'CARGO_CUOTA_TC', cruce_deuda_id: null })).toBe('COMPRA_CREDITO');
    expect(origenDeMovimiento({ tipo_movimiento: 'ABONO_SALDO_FAVOR_CARRO', cruce_deuda_id: null })).toBe('SALDO_A_FAVOR_CARRO');
    expect(origenDeMovimiento({ tipo_movimiento: 'ABONO_PAGO_RECIBIDO', cruce_deuda_id: null })).toBe('PAGO_RECIBIDO');
  });
});
