import { LineaGenericaEntrada, PlasticoEntrada, SIN_USO, Uso, claveAviso, construirLineaTiempo } from '../src/modules/productos-financieros/linea-tiempo.util';

const uso = (n: number, monto: number, primera: string | null, ultima: string | null): Uso => ({ n, monto, primera, ultima });

const plastico = (id: number, tarjetaId: number, ultimos4: string, tipo: 'CREDITO' | 'DEBITO', extra: Partial<PlasticoEntrada> = {}): PlasticoEntrada => ({
  id, tarjetaId, ultimos4, esActivo: false, vigenteDesde: null, vigenteHasta: null, reemplazaAId: null, tipo, franquicia: tipo === 'DEBITO' ? 'Débito' : 'Tarjeta de crédito', alias: null, cuentaId: null, ...extra,
});

/** Los 13 productos del plan (9 tarjetas + 4 cuentas/orígenes), con las vigencias de la semilla. */
const PLASTICOS: PlasticoEntrada[] = [
  plastico(2, 2, '9587', 'CREDITO', { franquicia: 'American Express', vigenteDesde: '2022-01-04', vigenteHasta: '2024-03-16' }),
  plastico(4, 2, '0088', 'CREDITO', { franquicia: 'American Express', vigenteDesde: '2024-03-20', vigenteHasta: '2024-06-04' }),
  plastico(3, 2, '1927', 'CREDITO', { franquicia: 'American Express', vigenteDesde: '2024-12-27', esActivo: true }),
  plastico(6, 1, '7293', 'CREDITO', { franquicia: 'Mastercard', vigenteDesde: '2022-08-25', vigenteHasta: '2024-03-16' }),
  plastico(5, 1, '5052', 'CREDITO', { franquicia: 'Mastercard', vigenteDesde: '2024-03-30', vigenteHasta: '2024-06-05' }),
  plastico(1, 1, '9491', 'CREDITO', { franquicia: 'Mastercard', vigenteDesde: '2024-12-28', esActivo: true }),
  plastico(7, 9, '4278', 'DEBITO', { alias: 'Débito *3698', cuentaId: 2, vigenteDesde: '2021-11-26', vigenteHasta: '2024-06-05' }),
  plastico(8, 9, '8949', 'DEBITO', { alias: 'Débito *3698', cuentaId: 2, vigenteDesde: '2025-01-05', vigenteHasta: '2025-03-10', reemplazaAId: 7 }),
  plastico(10, 9, '7992', 'DEBITO', { alias: 'Débito *3698', cuentaId: 2, vigenteDesde: '2026-09-19', esActivo: true, reemplazaAId: 8 }),
];
const GENERICA: LineaGenericaEntrada = { id: 11, franquicia: 'Tarjeta de crédito', alias: 'Crédito (sin número)' };
const CUENTAS = [
  { id: 2, nombre: 'Bancolombia Principal', bancoEntidad: 'Bancolombia', ultimos4: '3698', activa: true, esGenerica: false, inicioUso: '2021-08-09', finUso: null },
  { id: 1, nombre: 'Bancolombia Padre', bancoEntidad: 'Bancolombia', ultimos4: '4248', activa: true, esGenerica: false, inicioUso: '2026-09-17', finUso: null },
  { id: 3, nombre: 'Cuenta de ahorros (sin número)', bancoEntidad: 'Bancolombia', ultimos4: null, activa: false, esGenerica: true, inicioUso: '2021-08-27', finUso: '2026-07-22' },
];

describe('línea de tiempo de productos financieros', () => {
  const avisos = new Map<string, Uso>([
    [claveAviso('1927', 'TC'), uso(385, 40_000_000, '2024-12-27', '2026-10-15')],
    [claveAviso('9587', 'TC'), uso(189, 38_000_000, '2022-01-04', '2024-03-16')],
    [claveAviso('7992', 'CUENTA'), uso(23, 957_550.93, '2026-09-19', '2026-10-15')],
    [claveAviso('3698', 'CUENTA'), uso(855, 90_000_000, '2021-08-09', '2026-10-04')],
    [claveAviso(null, 'CUENTA'), uso(91, 5_000_000, '2021-08-27', '2026-07-22')],
    [claveAviso(null, 'TC'), uso(15, 1_000_000, '2023-11-29', '2026-10-03')],
  ]);
  const entrada = () => ({
    plasticos: PLASTICOS,
    lineasGenericas: [GENERICA],
    cuentas: CUENTAS,
    usos: {
      comprasPorPlastico: new Map<number, Uso>([[3, uso(1, 35_625, '2026-10-15', '2026-10-15')]]),
      comprasPorLinea: new Map<number, Uso>(),
      avisos,
      transaccionesPorCuenta: new Map<number, Uso>(),
    },
    hoy: '2026-10-16',
  });

  it('un renglón por cada uno de los 13 productos, ordenados por inicio de uso', () => {
    const t = construirLineaTiempo(entrada());
    expect(t.productos.length).toBe(13);
    expect(t.totales).toMatchObject({ productos: 13, activos: 6 }); // 1927, 9491, 7992, la tarjeta «sin número» y las dos cuentas activas
    const inicios = t.productos.map((p) => p.desde);
    expect([...inicios].sort((a, b) => (a ?? '9999').localeCompare(b ?? '9999'))).toEqual(inicios);
    expect(t.desde).toBe('2021-08-09'); // la cuenta *3698 es la más antigua
    expect(t.hasta).toBe('2026-10-16');
  });

  it('cada tarjeta lleva su tipo, su etiqueta y su estado según la cadena de su línea', () => {
    const p = Object.fromEntries(construirLineaTiempo(entrada()).productos.map((x) => [x.clave, x]));
    expect(p['plastico:3']).toMatchObject({ tipo: 'CREDITO', etiqueta: 'Crédito *1927', estado: 'ACTIVA', hasta: null, plasticoId: 3 });
    expect(p['plastico:2']).toMatchObject({ estado: 'REEMPLAZADA', desde: '2022-01-04', hasta: '2024-03-16' });
    expect(p['plastico:4']).toMatchObject({ estado: 'REEMPLAZADA' });
    expect(p['plastico:5']).toMatchObject({ estado: 'REEMPLAZADA' });
    expect(p['plastico:10']).toMatchObject({ tipo: 'DEBITO', etiqueta: 'Débito *7992', estado: 'ACTIVA', cuentaId: 2 });
    expect(p['plastico:7']).toMatchObject({ tipo: 'DEBITO', estado: 'REEMPLAZADA' });
  });

  it('las cifras salen de la fuente con más registros (sin sumar dos veces el mismo hecho)', () => {
    const p = Object.fromEntries(construirLineaTiempo(entrada()).productos.map((x) => [x.clave, x]));
    // 1927: 385 avisos del banco vs 1 compra registrada → mandan los avisos
    expect(p['plastico:3']).toMatchObject({ movimientos: 385, fuente: 'AVISOS', compras: 1, avisos: 385, monto: 40_000_000 });
    expect(p['plastico:10']).toMatchObject({ movimientos: 23, fuente: 'AVISOS', monto: 957_550.93 });
    expect(p['plastico:6']).toMatchObject({ movimientos: 0, fuente: 'NINGUNA' }); // 7293 sin avisos ni compras en esta base
  });

  it('las cuentas usan sus últimos 4; la «sin número» usa los avisos sin dígitos y la tarjeta «sin número» también', () => {
    const p = Object.fromEntries(construirLineaTiempo(entrada()).productos.map((x) => [x.clave, x]));
    expect(p['cuenta:2']).toMatchObject({ tipo: 'CUENTA', etiqueta: 'Cuenta *3698', ultimos4: '3698', estado: 'ACTIVA', movimientos: 855, desde: '2021-08-09', hasta: null });
    expect(p['cuenta:1']).toMatchObject({ etiqueta: 'Cuenta *4248', movimientos: 0 });
    expect(p['cuenta:3']).toMatchObject({ etiqueta: 'Cuenta (sin número)', generica: true, estado: 'INACTIVA', movimientos: 91, desde: '2021-08-27', hasta: '2026-07-22' });
    expect(p['tarjeta:11']).toMatchObject({ tipo: 'CREDITO', generica: true, etiqueta: 'Crédito (sin número)', movimientos: 15, desde: '2023-11-29', hasta: null });
  });

  it('un producto sin vigencias registradas toma su inicio y fin de los movimientos', () => {
    const t = construirLineaTiempo({
      plasticos: [plastico(1, 1, '1111', 'CREDITO')],
      lineasGenericas: [],
      cuentas: [],
      usos: { comprasPorPlastico: new Map([[1, uso(3, 300, '2025-02-01', '2025-04-01')]]), comprasPorLinea: new Map(), avisos: new Map(), transaccionesPorCuenta: new Map() },
      hoy: '2026-10-16',
    });
    expect(t.productos[0]).toMatchObject({ desde: '2025-02-01', hasta: '2025-04-01', estado: 'INACTIVA', movimientos: 3, fuente: 'REGISTROS' });
  });

  it('sin ningún producto devuelve una escala vacía de hoy a hoy', () => {
    const t = construirLineaTiempo({ plasticos: [], lineasGenericas: [], cuentas: [], usos: { comprasPorPlastico: new Map(), comprasPorLinea: new Map(), avisos: new Map(), transaccionesPorCuenta: new Map() }, hoy: '2026-10-16' });
    expect(t).toMatchObject({ desde: '2026-10-16', hasta: '2026-10-16', productos: [], totales: { productos: 0, activos: 0 } });
    expect(SIN_USO.n).toBe(0);
  });
});
