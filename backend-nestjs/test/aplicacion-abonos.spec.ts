import { Decimal } from '../src/config/decimal.config';
import { aplicarAbonosFifo, CargoAplicable } from '../src/modules/estado-cuenta-personas/aplicacion-abonos';
import { estadoDeCuota } from '../src/modules/liquidacion-mensual/cuotas-terceros.service';

const cargo = (clave: string, periodo: string, dia: number, monto: number): CargoAplicable => ({
  clave,
  periodo,
  fecha: new Date(Date.UTC(Number(periodo.slice(0, 4)), Number(periodo.slice(5)) - 1, dia)),
  monto: new Decimal(monto),
});

describe('aplicarAbonosFifo', () => {
  const cargos = [cargo('oct', '2026-10', 10, 100000), cargo('ago', '2026-08', 10, 50000), cargo('sep', '2026-09', 10, 70000)];

  it('salda del cargo más antiguo al más nuevo, sin importar el orden en que llegan', () => {
    const { coberturas, sobrante } = aplicarAbonosFifo(cargos, new Decimal(150000));
    expect(coberturas.get('ago')).toMatchObject({ estado: 'PAGADA' });
    expect(coberturas.get('sep')).toMatchObject({ estado: 'PAGADA' });
    expect(coberturas.get('oct')).toMatchObject({ estado: 'PARCIAL' });
    expect(coberturas.get('oct')!.cubierto.toString()).toBe('30000');
    expect(coberturas.get('oct')!.pendiente.toString()).toBe('70000');
    expect(sobrante.toString()).toBe('0');
  });

  it('sin abonos todo queda pendiente; con abonos de sobra queda un sobrante', () => {
    expect([...aplicarAbonosFifo(cargos, new Decimal(0)).coberturas.values()].every((c) => c.estado === 'PENDIENTE')).toBe(true);
    const { coberturas, sobrante } = aplicarAbonosFifo(cargos, new Decimal(500000));
    expect([...coberturas.values()].every((c) => c.estado === 'PAGADA')).toBe(true);
    expect(sobrante.toString()).toBe('280000');
  });

  it('un abono negativo se ignora y lo pendiente suma exactamente cargos − abonos', () => {
    expect([...aplicarAbonosFifo(cargos, new Decimal(-5)).coberturas.values()].every((c) => c.estado === 'PENDIENTE')).toBe(true);
    const { coberturas } = aplicarAbonosFifo(cargos, new Decimal(123456.78));
    const pendiente = [...coberturas.values()].reduce((a, c) => a.plus(c.pendiente), new Decimal(0));
    expect(pendiente.toString()).toBe(new Decimal(220000).minus(123456.78).toString());
  });

  it('en el mismo mes saldó primero el cargo de fecha más antigua', () => {
    const { coberturas } = aplicarAbonosFifo([cargo('b', '2026-10', 20, 40000), cargo('a', '2026-10', 5, 40000)], new Decimal(40000));
    expect(coberturas.get('a')).toMatchObject({ estado: 'PAGADA' });
    expect(coberturas.get('b')).toMatchObject({ estado: 'PENDIENTE' });
  });
});

describe('estadoDeCuota (igual que el Trigger 6)', () => {
  it('la cuota 1 y las de meses ya vencidos están confirmadas; las futuras, proyectadas', () => {
    expect(estadoDeCuota(1, '2027-05', '2026-10')).toBe('CONFIRMADO');
    expect(estadoDeCuota(4, '2026-10', '2026-10')).toBe('CONFIRMADO');
    expect(estadoDeCuota(3, '2026-09', '2026-10')).toBe('CONFIRMADO');
    expect(estadoDeCuota(2, '2026-11', '2026-10')).toBe('PROYECTADO');
  });
});
