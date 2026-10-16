import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EnteroOpcional, VacioAUndefined } from '../src/common/validators/normalizar-opcional.decorator';
import { ConciliarCorreoDto } from '../src/modules/notificaciones-correo/dto/notificacion.dto';
import { AsignarProductoDto } from '../src/modules/notificaciones-correo/dto/productos-correo.dto';

class Ejemplo {
  @VacioAUndefined() texto?: string;
  @EnteroOpcional() entero?: number;
}

describe('normalizadores de campos opcionales', () => {
  it('VacioAUndefined: "", null y texto en blanco equivalen a «no enviado»; lo demás queda igual', () => {
    for (const vacio of ['', '   ', null, undefined]) {
      expect(plainToInstance(Ejemplo, { texto: vacio }).texto).toBeUndefined();
    }
    expect(plainToInstance(Ejemplo, { texto: 'hola' }).texto).toBe('hola');
    expect(plainToInstance(Ejemplo, { texto: 0 }).texto).toBe(0 as unknown as string);
  });

  it('EnteroOpcional: convierte "12" en 12, trata lo vacío como ausente y deja pasar lo no numérico para que lo rechace @IsInt', () => {
    expect(plainToInstance(Ejemplo, { entero: '12' }).entero).toBe(12);
    expect(plainToInstance(Ejemplo, { entero: ' 7 ' }).entero).toBe(7);
    expect(plainToInstance(Ejemplo, { entero: 5 }).entero).toBe(5);
    for (const vacio of ['', '  ', null]) expect(plainToInstance(Ejemplo, { entero: vacio }).entero).toBeUndefined();
    expect(plainToInstance(Ejemplo, { entero: 'abc' }).entero).toBe('abc' as unknown as number);
    expect(plainToInstance(Ejemplo, { entero: '1.5' }).entero).toBe('1.5' as unknown as number);
  });
});

describe('ConciliarCorreoDto: el cuerpo que arma la pantalla', () => {
  const dto = (cuerpo: object) => plainToInstance(ConciliarCorreoDto, cuerpo);

  it('campos vacíos o null no son un 400 y quedan sin enviar (tarjetaId null NO debe crear una compra)', async () => {
    const d = dto({ accion: 'CONFIRMAR', concepto: ' ', categoriaId: '', cuentaId: '3', tarjetaId: null, numeroCuotas: '', monto: null, tasaCambio: '', notas: '' });
    expect(await validate(d)).toEqual([]);
    expect(d.cuentaId).toBe(3);
    for (const campo of ['concepto', 'categoriaId', 'tarjetaId', 'numeroCuotas', 'monto', 'tasaCambio', 'notas'] as const) {
      expect(d[campo]).toBeUndefined();
    }
  });

  it('la TRM es opcional pero, si viene, debe ser un número positivo', async () => {
    expect(await validate(dto({ tarjetaId: 1, tasaCambio: '4100.5' }))).toEqual([]);
    expect(await validate(dto({ tarjetaId: 1, tasaCambio: 4100 }))).toEqual([]);
    const mala = await validate(dto({ tarjetaId: 1, tasaCambio: '-5' }));
    expect(mala.map((e) => e.property)).toEqual(['tasaCambio']);
    const texto = await validate(dto({ tarjetaId: 1, tasaCambio: 'abc' }));
    expect(texto.map((e) => e.property)).toEqual(['tasaCambio']);
  });

  it('la fecha corregida es opcional, vacía = no enviada, y solo admite yyyy-MM-dd', async () => {
    expect(dto({ fecha: '' }).fecha).toBeUndefined();
    expect(await validate(dto({ fecha: '2026-10-15' }))).toEqual([]);
    expect((await validate(dto({ fecha: '15/10/2026' }))).map((e) => e.property)).toEqual(['fecha']);
  });

  it('un id que no es entero sigue siendo inválido (no se oculta el error)', async () => {
    const errores = await validate(dto({ tarjetaId: 'abc', categoriaId: 1.5 }));
    expect(errores.map((e) => e.property).sort()).toEqual(['categoriaId', 'tarjetaId']);
  });
});

describe('AsignarProductoDto', () => {
  it('acepta el id como texto y el bloque «nuevo» con campos vacíos', async () => {
    const d = plainToInstance(AsignarProductoDto, { ultimos4: '0088', destino: 'TARJETA', id: '4', nuevo: null });
    expect(await validate(d)).toEqual([]);
    expect(d.id).toBe(4);
    expect(d.nuevo).toBeUndefined();

    const n = plainToInstance(AsignarProductoDto, { ultimos4: '0088', destino: 'TARJETA', nuevo: { franquicia: '', descripcion: '' } });
    expect(await validate(n, { whitelist: true })).toEqual([]);
    expect(n.nuevo?.franquicia).toBeUndefined();
  });
});
