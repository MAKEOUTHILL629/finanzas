import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCuentaFinancieraDto, UpdateCuentaFinancieraDto } from '../src/modules/cuentas-financieras/dto/cuenta-categoria.dto';

const base = { nombre: 'Bancolombia', tipoCuenta: 'AHORROS' };

async function errores(clase: new () => object, obj: Record<string, unknown>): Promise<string[]> {
  return (await validate(plainToInstance(clase, obj))).map((e) => e.property).sort();
}

describe('ultimos4Digitos en cuentas (uno o varios grupos de 4)', () => {
  it.each(['1234', '3698,4278', '3698, 4278', '3698 4278', '1111;2222;3333'])('acepta "%s"', async (valor) => {
    expect(await errores(CreateCuentaFinancieraDto, { ...base, ultimos4Digitos: valor })).toEqual([]);
    expect(await errores(UpdateCuentaFinancieraDto, { ultimos4Digitos: valor })).toEqual([]);
  });

  it.each(['123', '12345', 'abcd', '3698,42', '3698,,4278', ',3698', '3698,', '12 34'])('rechaza "%s"', async (valor) => {
    expect(await errores(CreateCuentaFinancieraDto, { ...base, ultimos4Digitos: valor })).toEqual(['ultimos4Digitos']);
    expect(await errores(UpdateCuentaFinancieraDto, { ultimos4Digitos: valor })).toEqual(['ultimos4Digitos']);
  });

  it('no es obligatorio', async () => {
    expect(await errores(CreateCuentaFinancieraDto, base)).toEqual([]);
  });
});
