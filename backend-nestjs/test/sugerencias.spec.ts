import { agruparComercios, moda, normalizarParaBuscar, ordenarPorUso } from '../src/modules/sugerencias/sugerencias.util';

const compra = (concepto: string | null, fecha: string, extra: Partial<{ numeroCuotas: number | null; tarjetaId: number | null; personas: number[]; valor: number | null }> = {}) => ({
  concepto,
  valor: 1000,
  numeroCuotas: 1,
  tarjetaId: 2,
  fecha: new Date(`${fecha}T00:00:00Z`),
  personas: [],
  ...extra,
});
const egreso = (concepto: string | null, fecha: string, extra: Partial<{ categoriaId: number | null; cuentaId: number | null }> = {}) => ({
  concepto,
  categoriaId: null,
  cuentaId: null,
  fecha: new Date(`${fecha}T00:00:00Z`),
  ...extra,
});

describe('moda', () => {
  it('el valor más repetido; en un empate gana el que aparece primero (el más reciente)', () => {
    expect(moda([3, 1, 1, 3, 2])).toBe(3);
    expect(moda([1, 2, 2, 1])).toBe(1);
    expect(moda(['a', 'b', 'b'])).toBe('b');
  });

  it('ignora null y undefined; sin valores → null', () => {
    expect(moda([null, undefined, 5, null])).toBe(5);
    expect(moda([null, undefined])).toBeNull();
    expect(moda([])).toBeNull();
  });
});

describe('ordenarPorUso', () => {
  it('de más a menos usado y, a igual uso, el más reciente primero', () => {
    expect(
      ordenarPorUso([
        { id: 1, n: 2, ultima: 10 },
        { id: 2, n: 5, ultima: 1 },
        { id: 3, n: 2, ultima: 99 },
      ]),
    ).toEqual([2, 3, 1]);
    expect(ordenarPorUso([])).toEqual([]);
  });
});

describe('normalizarParaBuscar', () => {
  it('sin tildes, minúsculas y sin signos', () => {
    expect(normalizarParaBuscar('  ÉXITO – Express! ')).toBe('exito express');
  });
});

describe('agruparComercios', () => {
  it('junta las formas de escribir un mismo comercio y muestra la más usada', () => {
    const r = agruparComercios(
      [compra('DL*DIDI FOOD CO', '2026-10-13'), compra('Didi Food', '2026-10-10'), compra('Didi Food', '2026-09-30'), compra('Éxito', '2026-10-01')],
      [],
    );
    expect(r.map((c) => [c.concepto, c.veces])).toEqual([['Didi Food', 3], ['Éxito', 1]]);
    expect(r[0].ultimaFecha).toBe('2026-10-13');
  });

  it('resume lo habitual: cuotas, tarjeta, responsable, categoría y cuenta', () => {
    const r = agruparComercios(
      [
        compra('Nevera', '2026-10-01', { numeroCuotas: 12, tarjetaId: 1, personas: [2] }),
        compra('Nevera', '2026-08-01', { numeroCuotas: 12, tarjetaId: 1, personas: [2, 3] }),
        compra('Nevera', '2026-06-01', { numeroCuotas: 6, tarjetaId: 4, personas: [3] }),
      ],
      [egreso('NEVERA', '2026-05-01', { categoriaId: 7, cuentaId: 9 }), egreso('Nevera', '2026-04-01', { categoriaId: 7, cuentaId: 8 })],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ veces: 5, cuotas: 12, tarjetaId: 1, personaId: 2, categoriaId: 7, cuentaId: 9 });
  });

  it('ultimoValor es lo que costó la compra más reciente (ignora valores vacíos y los egresos)', () => {
    const r = agruparComercios(
      [compra('Youtube', '2026-08-01', { valor: 24900 }), compra('Youtube', '2026-10-01', { valor: 27900 }), compra('Youtube', '2026-09-01', { valor: 25900 }), compra('Spotify', '2026-10-02', { valor: null }), compra('Tienda', '2026-10-03', { valor: 0 })],
      [egreso('Youtube', '2026-10-05'), egreso('Spotify', '2026-10-06')],
    );
    const por = (c: string) => r.find((x) => x.concepto === c)?.ultimoValor;
    expect(por('Youtube')).toBe(27900); // la compra de octubre, no el egreso más nuevo ni la de agosto
    expect(por('Spotify')).toBeNull();
    expect(por('Tienda')).toBeNull();
  });

  it('una persona cuenta una vez por compra aunque figure repetida', () => {
    const r = agruparComercios([compra('Mercado', '2026-10-01', { personas: [5, 5] }), compra('Mercado', '2026-09-01', { personas: [6] }), compra('Mercado', '2026-08-01', { personas: [6] })], []);
    expect(r[0].personaId).toBe(6);
  });

  it('ordena por frecuencia y, a igualdad, por recencia; respeta el límite', () => {
    const r = agruparComercios(
      [compra('Uber', '2026-10-01'), compra('Uber', '2026-09-01'), compra('Netflix', '2026-10-05'), compra('Spotify', '2026-08-05'), compra('Éxito', '2026-10-02'), compra('Éxito', '2026-07-02')],
      [],
    );
    expect(r.map((c) => c.concepto)).toEqual(['Éxito', 'Uber', 'Netflix', 'Spotify']);
    expect(agruparComercios([compra('A', '2026-10-01'), compra('B', '2026-10-02')], [], 1)).toHaveLength(1);
  });

  it('filtra sin importar mayúsculas ni tildes', () => {
    const datos = [compra('Éxito Express', '2026-10-01'), compra('Netflix', '2026-10-02')];
    expect(agruparComercios(datos, [], 10, 'exito').map((c) => c.concepto)).toEqual(['Éxito Express']);
    expect(agruparComercios(datos, [], 10, 'NETF').map((c) => c.concepto)).toEqual(['Netflix']);
    expect(agruparComercios(datos, [], 10, 'zzz')).toEqual([]);
  });

  it('descarta conceptos vacíos o nulos y tolera fechas desconocidas', () => {
    const r = agruparComercios([compra(null, '2026-10-01'), compra('   ', '2026-10-01'), { ...compra('Tienda', '2026-10-01'), fecha: null }], [egreso(null, '2026-10-01')]);
    expect(r.map((c) => c.concepto)).toEqual(['Tienda']);
    expect(r[0].ultimaFecha).toBeNull();
  });
});
