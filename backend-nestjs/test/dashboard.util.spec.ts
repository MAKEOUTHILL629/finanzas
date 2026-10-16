import { fechaLimiteExtracto, proximosVencimientos } from '../src/modules/dashboard/dashboard.util';

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

describe('fechaLimiteExtracto', () => {
  it('si el límite es menor o igual al corte, el pago cae en el mes siguiente (corte 15, paga hasta el 5)', () => {
    expect(iso(fechaLimiteExtracto('2026-10', 15, 5))).toBe('2026-11-05');
    expect(iso(fechaLimiteExtracto('2026-12', 15, 5))).toBe('2027-01-05'); // cruza de año
    expect(iso(fechaLimiteExtracto('2026-10', 15, 15))).toBe('2026-11-15');
  });

  it('si el límite es mayor al corte, el pago cae en el mismo mes (corte 15, paga hasta el 30)', () => {
    expect(iso(fechaLimiteExtracto('2026-10', 15, 30))).toBe('2026-10-30');
  });

  it('sin día de corte se asume el mes siguiente; sin día límite no hay fecha', () => {
    expect(iso(fechaLimiteExtracto('2026-10', null, 20))).toBe('2026-11-20');
    expect(fechaLimiteExtracto('2026-10', 15, null)).toBeNull();
    expect(fechaLimiteExtracto('2026-10', 15, 0)).toBeNull();
  });

  it('el día se ajusta al último del mes (límite 31 en febrero)', () => {
    expect(iso(fechaLimiteExtracto('2027-01', 31, 31))).toBe('2027-02-28'); // corte 31 → paga el mes siguiente, que solo tiene 28 días
    expect(iso(fechaLimiteExtracto('2028-01', 31, 31))).toBe('2028-02-29'); // bisiesto
    expect(iso(fechaLimiteExtracto('2027-12', 20, 31))).toBe('2027-12-31');
  });
});

describe('proximosVencimientos', () => {
  const hoy = dia('2026-10-16');
  const extractos = [
    { periodo: '2026-09', monto: 100 }, // vencía el 5 de oct: 11 días de atraso
    { periodo: '2026-10', monto: 200 }, // vence el 5 de nov
    { periodo: '2026-11', monto: 300 }, // vence el 5 de dic
    { periodo: '2027-03', monto: 400 }, // demasiado lejos
    { periodo: '2026-07', monto: 50 }, // vencía el 5 de ago: más de 45 días, ya es historia
    { periodo: '2026-12', monto: 0 }, // nada que pagar
  ];

  it('ordena por fecha, marca los vencidos y deja fuera lo lejano, lo viejo y lo que está en cero', () => {
    const v = proximosVencimientos(hoy, extractos, 15, 5);
    expect(v.map((x) => [x.periodo, x.fecha, x.diasRestantes, x.vencido])).toEqual([
      ['2026-09', '2026-10-05', -11, true],
      ['2026-10', '2026-11-05', 20, false],
      ['2026-11', '2026-12-05', 50, false],
    ]);
  });

  it('una tarjeta sin día límite configurado no tiene vencimientos', () => {
    expect(proximosVencimientos(hoy, extractos, 15, null)).toEqual([]);
  });

  it('el horizonte y la ventana de vencidos se pueden ajustar', () => {
    expect(proximosVencimientos(hoy, extractos, 15, 5, { horizonteDias: 30, ventanaVencidos: 5 }).map((x) => x.periodo)).toEqual(['2026-10']);
  });
});
