import { Decimal } from '../src/config/decimal.config';
import { agregarFilas, FilaAnalitica } from '../src/modules/analitica/analitica.service';
import { parsearConsulta } from '../src/modules/analitica/consulta-lenguaje.util';
import { inferirComercioYTags, ventanasDeViaje } from '../src/modules/notificaciones-correo/comercio.util';

describe('Fase 2 — inferirComercioYTags (desambiguación)', () => {
  it.each([
    ['DIDI*FOOD CO', 'DiDi Food', ['#domicilios', '#didi-food']],
    ['DIDI RIDES', 'DiDi Rides', ['#transporte', '#didi-rides']],
    ['RAPPI', 'Rappi', ['#domicilios', '#rappi']],
    ['RAPPI PRIME', 'Rappi Pro', ['#suscripciones', '#rappi']],
    ['BERSHKA COLOMBIA', 'Bershka', ['#ropa', '#bershka']],
    ['KOAJ', 'Koaj', ['#ropa', '#koaj']],
    ['AIRBNB', null, ['#viajes']],
    ['UBER EATS', 'Uber Eats', ['#domicilios', '#uber-eats']],
    ['UBER TRIP', null, ['#transporte']],
  ])('%s → %s %s', (raw, canonico, tags) => {
    const r = inferirComercioYTags(raw as string);
    expect(r.comercioCanonico).toBe(canonico);
    for (const t of tags as string[]) expect(r.tags).toContain(t);
  });

  it('ventanas de viaje agrupan anclas cercanas y dan margen', () => {
    const v = ventanasDeViaje([new Date('2026-01-10'), new Date('2026-01-15'), new Date('2026-06-01')]);
    expect(v).toHaveLength(2);
    expect(v[0].desde.toISOString().slice(0, 10)).toBe('2026-01-09');
    expect(v[0].hasta.toISOString().slice(0, 10)).toBe('2026-01-18');
  });
});

describe('Fase 2 — Pregúntale a tu App (parser + agregación)', () => {
  it('extrae tags/comercios y periodo de la pregunta', () => {
    const hoy = new Date('2026-10-20T12:00:00Z');
    const p = parsearConsulta('¿Cuánta plata he gastado en domicilios en Rappi y en Didi?', hoy);
    expect(p.tags).toEqual(expect.arrayContaining(['#domicilios', '#rappi', '#didi-food']));
    expect(p.comercios).toEqual(expect.arrayContaining(['Rappi', 'DiDi Food']));
    const p2 = parsearConsulta('¿Cuánto en Bershka o Koaj este año?', hoy);
    expect(p2.comercios).toEqual(expect.arrayContaining(['Bershka', 'Koaj']));
    expect(p2.desde?.toISOString().slice(0, 10)).toBe('2026-01-01');
    const p3 = parsearConsulta('¿Cuánto en viajes en 2025?', hoy);
    expect(p3.tags).toContain('#viajes');
    expect(p3.desde?.toISOString().slice(0, 4)).toBe('2025');
  });

  it('la suma coincide con los registros etiquetados (Decimal exacto)', () => {
    const filas: FilaAnalitica[] = [
      { tipo: 'COMPRA_TC', id: 1, fecha: '2026-10-01', descripcion: 'RAPPI', comercioCanonico: 'Rappi', tags: ['#domicilios', '#rappi'], monto: new Decimal('50000.50') },
      { tipo: 'COMPRA_TC', id: 2, fecha: '2026-10-02', descripcion: 'DIDI FOOD', comercioCanonico: 'DiDi Food', tags: ['#domicilios', '#didi-food'], monto: new Decimal('30000.50') },
      { tipo: 'TRANSACCION', id: 3, fecha: '2026-10-03', descripcion: 'RAPPI', comercioCanonico: 'Rappi', tags: ['#domicilios', '#rappi'], monto: new Decimal('20000') },
    ];
    const agg = agregarFilas(filas);
    expect(agg.total.toString()).toBe('100001');
    expect(agg.operaciones).toBe(3);
    expect(agg.desglose[0]).toMatchObject({ clave: 'Rappi', operaciones: 2 });
    expect(agg.desglose[0].total.toString()).toBe('70000.5');
  });
});
