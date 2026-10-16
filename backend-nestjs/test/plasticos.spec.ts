import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarPlasticoDto, ReemplazarPlasticoDto } from '../src/modules/tarjetas/dto/plasticos.dto';
import { cadenaUltimos4, cierreDelAnterior, diaAnterior, PlasticoBase, plasticoParaFecha, reemplazoAnteriorAlInicio, tokensUltimos4 } from '../src/modules/tarjetas/plasticos.util';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const plastico = (id: number, ultimos4: string, extra: Partial<PlasticoBase> = {}): PlasticoBase => ({ id, ultimos4, esActivo: false, vigenteDesde: null, vigenteHasta: null, ...extra });

describe('plásticos — tokensUltimos4 / cadenaUltimos4', () => {
  it('extrae grupos de 4 dígitos sin repetir y en orden', () => {
    expect(tokensUltimos4('1927, 9587;1927')).toEqual(['1927', '9587']);
    expect(tokensUltimos4('Visa Oro *1927')).toEqual(['1927']);
    expect(tokensUltimos4('12345')).toEqual([]); // 5 dígitos no son un grupo
    expect(tokensUltimos4(null)).toEqual([]);
  });

  it('la cadena guarda el plástico activo primero y luego los demás del más reciente al más antiguo', () => {
    const cadena = cadenaUltimos4([
      { ultimos4: '9587', esActivo: false, orden: 1 },
      { ultimos4: '1927', esActivo: true, orden: 3 },
      { ultimos4: '0088', esActivo: false, orden: 2 },
    ]);
    expect(cadena).toBe('1927,0088,9587');
  });
});

describe('plásticos — plástico vigente en una fecha', () => {
  const cadena = [
    plastico(1, '9587', { vigenteDesde: null, vigenteHasta: d('2024-03-16') }),
    plastico(2, '0088', { vigenteDesde: d('2024-03-20'), vigenteHasta: d('2024-06-04') }),
    plastico(3, '1927', { vigenteDesde: d('2024-12-27'), esActivo: true }),
  ];

  it('elige el plástico de inicio más reciente que no sea posterior a la fecha', () => {
    expect(plasticoParaFecha(cadena, d('2023-05-01'))?.plastico.ultimos4).toBe('9587');
    expect(plasticoParaFecha(cadena, d('2024-03-20'))?.plastico.ultimos4).toBe('0088');
    expect(plasticoParaFecha(cadena, d('2024-08-10'))?.plastico.ultimos4).toBe('0088'); // hueco sin avisos: sigue el último conocido
    expect(plasticoParaFecha(cadena, d('2026-10-15'))?.plastico.ultimos4).toBe('1927');
  });

  it('una fecha anterior al inicio de todos cae en el más antiguo; sin fecha, en el activo', () => {
    const sinInicioDesconocido = [plastico(1, '1111', { vigenteDesde: d('2025-01-01') }), plastico(2, '2222', { vigenteDesde: d('2026-01-01'), esActivo: true })];
    expect(plasticoParaFecha(sinInicioDesconocido, d('2020-01-01'))?.plastico.ultimos4).toBe('1111');
    expect(plasticoParaFecha(cadena, null)?.plastico.ultimos4).toBe('1927');
  });

  it('sin plásticos no hay nada; con uno solo siempre es ese (y se marca como deducido)', () => {
    expect(plasticoParaFecha([], d('2026-01-01'))).toBeNull();
    expect(plasticoParaFecha([plastico(9, '9491', { esActivo: true })], d('2020-01-01'))).toEqual({ plastico: expect.objectContaining({ ultimos4: '9491' }), inferido: true });
  });
});

describe('plásticos — cierre del plástico que se reemplaza', () => {
  it('cierra la víspera del plástico nuevo', () => {
    expect(diaAnterior(d('2026-03-01')).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(cierreDelAnterior(d('2025-01-01'), d('2026-10-01')).toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('un plástico reemplazado el mismo día que empezó queda de un solo día (nunca cierra antes de abrir)', () => {
    expect(cierreDelAnterior(d('2026-10-01'), d('2026-10-01')).toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('detecta un reemplazo que empieza antes que el plástico actual', () => {
    expect(reemplazoAnteriorAlInicio(d('2026-05-01'), d('2026-04-30'))).toBe(true);
    expect(reemplazoAnteriorAlInicio(d('2026-05-01'), d('2026-05-01'))).toBe(false);
    expect(reemplazoAnteriorAlInicio(null, d('2020-01-01'))).toBe(false);
  });
});

describe('plásticos — validación de los DTO', () => {
  const errores = async (cls: any, obj: Record<string, unknown>) => (await validate(plainToInstance(cls, obj))).map((e) => e.property).sort();

  it('reemplazo: 4 dígitos, fecha yyyy-MM-dd y motivo conocido', async () => {
    expect(await errores(ReemplazarPlasticoDto, { ultimos4: '9587' })).toEqual([]);
    expect(await errores(ReemplazarPlasticoDto, { ultimos4: '9587', vigenteDesde: '2026-10-01', motivo: 'PERDIDA', notas: 'La perdí en el viaje' })).toEqual([]);
    expect(await errores(ReemplazarPlasticoDto, { ultimos4: '958', vigenteDesde: '01/10/2026', motivo: 'ROBADA' })).toEqual(['motivo', 'ultimos4', 'vigenteDesde']);
  });

  it('actualización: admite null para borrar fechas y rechaza formatos raros', async () => {
    expect(await errores(ActualizarPlasticoDto, {})).toEqual([]);
    expect(await errores(ActualizarPlasticoDto, { vigenteDesde: null, vigenteHasta: null, motivo: null, notas: null })).toEqual([]);
    expect(await errores(ActualizarPlasticoDto, { vigenteDesde: 'ayer', esActivo: 'si' })).toEqual(['esActivo', 'vigenteDesde']);
  });
});
