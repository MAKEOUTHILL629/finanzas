import {
  construirFechaHora,
  decidirRuta,
  detectarInstrumento,
  esAvisoInformativo,
  extraerUltimos4,
  parseMontoBancolombia,
  prioridadRuta,
  resolverCuenta,
  resolverTarjeta,
  tokensDe4Digitos,
} from '../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { isMoneyValue } from '../src/common/validators/is-money.decorator';

describe('extraerUltimos4 — variantes de cuenta y tarjeta que emite Bancolombia', () => {
  it.each([
    ['cta *3698', '3698'],
    ['Cuenta *3698', '3698'],
    ['Cuenta 3698', '3698'],
    ['producto *3698', '3698'],
    ['Producto *3698', '3698'],
    ['Cuenta *4248', '4248'],
    ['*4278', '4278'],
    ['Tarjeta Debito *7992', '7992'],
    ['*8949', '8949'],
    ['T.Cred *1927', '1927'],
    ['T.Cred  *1927', '1927'], // doble espacio
    ['Tarjeta de credito *1927', '1927'],
    ['T.Cred *9491', '9491'],
    ['T.Cred *9587', '9587'],
    ['T.Cred *0088', '0088'], // ceros a la izquierda se conservan
    ['T.Cred *7293', '7293'],
    ['T.Cred *5052', '5052'],
  ])('"%s" → %s', (origen, esperado) => {
    expect(extraerUltimos4(origen)).toBe(esperado);
  });

  it('sin 4 dígitos o vacío → null; no toma 4 dígitos del medio de un número largo', () => {
    expect(extraerUltimos4('Bre-b')).toBeNull();
    expect(extraerUltimos4('')).toBeNull();
    expect(extraerUltimos4(undefined)).toBeNull();
    expect(extraerUltimos4('Cuenta 123')).toBeNull();
    expect(extraerUltimos4('Cuenta 12345678')).toBeNull();
  });
});

describe('detectarInstrumento / esAvisoInformativo', () => {
  it('tarjeta de crédito por el origen o por el método', () => {
    expect(detectarInstrumento('T.Cred *1927', 'Cuenta Ahorros')).toBe('TC');
    expect(detectarInstrumento('Tarjeta de crédito *1927', null)).toBe('TC');
    expect(detectarInstrumento('*1927', 'Tarjeta Credito')).toBe('TC');
    expect(detectarInstrumento('cta *3698', 'Cuenta Ahorros')).toBe('CUENTA');
    expect(detectarInstrumento('*4278', 'Tarjeta Debito')).toBe('CUENTA');
  });

  it.each([
    ['Tu factura se vence el 15 de octubre', true],
    ['Ya inscribiste tu cuenta', true],
    ['Registraste tu llave Bre-B', true],
    ['SE VENCE EL plazo', true],
    ['Compra por $50.000 en EXITO', false],
    [null, false],
  ])('aviso informativo "%s" → %s', (asunto, esperado) => {
    expect(esAvisoInformativo(asunto as string | null)).toBe(esperado);
  });
});

describe('decidirRuta — enrutamiento transaccional', () => {
  const ruta = (tipo: string, metodo: string, extra: Record<string, unknown> = {}) =>
    decidirRuta({ tipo, metodo, origenRaw: 'cta *3698', ...extra });

  it('error de parseo o aviso → IGNORAR (tiene prioridad sobre todo)', () => {
    expect(ruta('Compra', 'Tarjeta Credito', { esErrorParsing: true })).toBe('IGNORAR');
    expect(ruta('Desconocido', 'QR', { asunto: 'Tu producto se vence el 20' })).toBe('IGNORAR');
    expect(ruta('Compra', 'Tarjeta Credito', { asunto: 'Registraste tu llave' })).toBe('IGNORAR');
  });

  it.each([
    ['Compra', 'Tarjeta Credito'],
    ['Avance', 'Tarjeta Credito'],
  ])('%s con %s → COMPRA_TC', (tipo, metodo) => {
    expect(ruta(tipo, metodo, { origenRaw: 'T.Cred *1927' })).toBe('COMPRA_TC');
  });

  it.each([
    ['Pago', 'Pago Tarjeta'],
    ['Abono Tarjeta', 'Cuenta Ahorros'],
    ['Abono Deuda', 'Tarjeta Credito'],
    ['Transferencia', 'Pago Tarjeta'],
  ])('%s / %s → PAGO_TARJETA', (tipo, metodo) => {
    expect(ruta(tipo, metodo)).toBe('PAGO_TARJETA');
  });

  it.each([
    ['Ingreso', 'Cuenta Ahorros'],
    ['Pago Proveedor', 'Cuenta Ahorros/Corriente'],
    ['Ingreso', 'Transfiya/Bre-b'],
  ])('%s / %s → INGRESO', (tipo, metodo) => {
    expect(ruta(tipo, metodo)).toBe('INGRESO');
  });

  it.each([
    ['Transferencia', 'Cuenta Ahorros/Corriente'],
    ['Pago', 'QR'],
    ['Retiro', 'Cuenta Ahorros'],
    ['Compra', 'Tarjeta Debito'],
    ['Pago', 'Boton Bancolombia'],
    ['Transferencia', 'Llaves'],
  ])('%s / %s → EGRESO', (tipo, metodo) => {
    expect(ruta(tipo, metodo)).toBe('EGRESO');
  });

  it('combinaciones no previstas → SIN_RUTA (revisión manual)', () => {
    expect(ruta('Desconocido', 'QR')).toBe('SIN_RUTA');
    expect(ruta('Pago', 'Tarjeta Credito', { origenRaw: 'T.Cred *1927' })).toBe('SIN_RUTA'); // TC no es una cuenta
    expect(ruta('', '')).toBe('SIN_RUTA');
  });

  it('insensible a mayúsculas y tildes', () => {
    expect(ruta('COMPRA', 'TARJETA CRÉDITO'.replace('É', 'E'), { origenRaw: 'T.Cred *1927' })).toBe('COMPRA_TC');
    expect(ruta('Abono Tarjeta', 'x')).toBe('PAGO_TARJETA');
  });

  it('el débito del pago se procesa antes que el abono en la tarjeta', () => {
    expect(prioridadRuta({ tipo: 'Pago', metodo: 'Pago Tarjeta' })).toBeLessThan(prioridadRuta({ tipo: 'Abono Tarjeta', metodo: 'x' }));
  });
});

describe('parseMontoBancolombia', () => {
  it.each([
    ['50000', 'COP', '50000'],
    ['50.000', 'COP', '50000'],
    ['1.250.000', 'COP', '1250000'],
    ['50.000,50', 'COP', '50000.5'],
    ['$ 1.234.567,89', 'COP', '1234567.89'],
    ['1,234.56', 'USD', '1234.56'],
    ['49.99', 'USD', '49.99'],
    ['49,99', 'USD', '49.99'],
    ['1,234', 'USD', '1234'],
    ['12,5', 'COP', '12.5'],
    ['-8.500', 'COP', '-8500'],
  ])('%s (%s) → %s', (valor, moneda, esperado) => {
    expect(parseMontoBancolombia(valor, moneda as 'COP' | 'USD')?.toString()).toBe(esperado);
  });

  it('número, vacío e inválido', () => {
    expect(parseMontoBancolombia(50000.5)?.toString()).toBe('50000.5');
    expect(parseMontoBancolombia('')).toBeNull();
    expect(parseMontoBancolombia('abc')).toBeNull();
    expect(parseMontoBancolombia(null)).toBeNull();
  });
});

describe('construirFechaHora', () => {
  it('interpreta la hora en la zona del buzón (Bogotá = UTC-5)', () => {
    expect(construirFechaHora('2026-10-13', '14:02:11')?.toISOString()).toBe('2026-10-13T19:02:11.000Z');
    expect(construirFechaHora('2026-10-13', '23:30')?.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    expect(construirFechaHora('2026-10-13', '08:00:00', '+00:00')?.toISOString()).toBe('2026-10-13T08:00:00.000Z');
  });

  it('formatos inválidos → null', () => {
    expect(construirFechaHora('13/10/2026', '14:02:11')).toBeNull();
    expect(construirFechaHora('2026-10-13', '2pm')).toBeNull();
    expect(construirFechaHora('2026-13-45', '14:02:11')).toBeNull();
  });
});

describe('resolución de cuentas y tarjetas por últimos 4 dígitos', () => {
  const cuentas = [
    { id: 1n, ultimos_4_digitos: '3698' },
    { id: 2n, ultimos_4_digitos: '4248, 4278' }, // cuenta + tarjeta débito
    { id: 3n, ultimos_4_digitos: '7992,8949' },
    { id: 4n, ultimos_4_digitos: null },
  ];
  const tarjetas = [
    { id: 10n, descripcion: 'Visa Oro *1927', franquicia: 'Visa' },
    { id: 11n, descripcion: 'Mastercard Black 9491', franquicia: 'Mastercard' },
    { id: 12n, descripcion: 'Sin número', franquicia: 'Amex' },
  ];

  it('tokensDe4Digitos', () => {
    expect(tokensDe4Digitos('3698, 4278 y *1234')).toEqual(['3698', '4278', '1234']);
    expect(tokensDe4Digitos('12345')).toEqual([]);
    expect(tokensDe4Digitos(null)).toEqual([]);
  });

  it('cuenta: coincidencia inequívoca, múltiples valores por cuenta', () => {
    expect(resolverCuenta(cuentas, '3698')?.id).toBe(1n);
    expect(resolverCuenta(cuentas, '4278')?.id).toBe(2n);
    expect(resolverCuenta(cuentas, '8949')?.id).toBe(3n);
    expect(resolverCuenta(cuentas, '0000')).toBeNull();
    expect(resolverCuenta(cuentas, null)).toBeNull();
  });

  it('cuenta ambigua (mismos dígitos en dos cuentas) → null', () => {
    expect(resolverCuenta([...cuentas, { id: 9n, ultimos_4_digitos: '3698' }], '3698')).toBeNull();
  });

  it('tarjeta: número dentro de descripcion o franquicia; ambigua o ausente → null', () => {
    expect(resolverTarjeta(tarjetas, '1927')?.id).toBe(10n);
    expect(resolverTarjeta(tarjetas, '9491')?.id).toBe(11n);
    expect(resolverTarjeta(tarjetas, '5052')).toBeNull();
    expect(resolverTarjeta([...tarjetas, { id: 13n, descripcion: 'Otra *1927', franquicia: 'Visa' }], '1927')).toBeNull();
  });
});

describe('isMoneyValue (montos como number o string)', () => {
  it('acepta number y string decimal', () => {
    expect(isMoneyValue(100)).toBe(true);
    expect(isMoneyValue('1500.50')).toBe(true);
    expect(isMoneyValue('0')).toBe(true);
    expect(isMoneyValue(0.1)).toBe(true);
  });

  it('respeta decimales, positividad y signo', () => {
    expect(isMoneyValue('10.123')).toBe(false);
    expect(isMoneyValue('10.1234', { maxDecimals: 4 })).toBe(true);
    expect(isMoneyValue(0, { positive: true })).toBe(false);
    expect(isMoneyValue('-5')).toBe(false);
    expect(isMoneyValue('-5', { allowNegative: true })).toBe(true);
  });

  it('rechaza NaN, Infinity, texto no numérico, notación científica en string y otros tipos', () => {
    expect(isMoneyValue(NaN)).toBe(false);
    expect(isMoneyValue(Infinity)).toBe(false);
    expect(isMoneyValue('12abc')).toBe(false);
    expect(isMoneyValue('1e3')).toBe(false);
    expect(isMoneyValue('1,5')).toBe(false);
    expect(isMoneyValue(null)).toBe(false);
    expect(isMoneyValue({})).toBe(false);
  });
});
