/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { resolverCuenta } from '../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { CrearTarjetaDto } from '../src/modules/tarjetas/dto/crear-tarjeta.dto';
import { TarjetasService } from '../src/modules/tarjetas/tarjetas.service';
import { cuentasConDebitos, estadosDePlasticos, soloCredito } from '../src/modules/tarjetas/tipos-tarjeta.util';
import { WebScrapingService } from '../src/modules/tarjetas/web-scraping.service';
import { createPrismaMock, utc } from './helpers/prisma-mock';

const OWNER = 7n;

describe('tipos de tarjeta — utilidades puras', () => {
  it('soloCredito deja las de crédito y las que no declaran tipo (las de siempre)', () => {
    const l = [{ id: 1, tipo_tarjeta: 'CREDITO' }, { id: 2, tipo_tarjeta: 'DEBITO' }, { id: 3 }];
    expect(soloCredito(l).map((t) => t.id)).toEqual([1, 3]);
  });

  it('los últimos 4 de la tarjeta de débito identifican a su cuenta, sin modificar la fila de la cuenta', () => {
    const cuentas = [{ id: 2n, ultimos_4_digitos: '3698' }, { id: 1n, ultimos_4_digitos: '4248' }];
    const tarjetas = [
      { tipo_tarjeta: 'DEBITO', cuenta_id: 2n, ultimos_4_digitos: '7992,8949,4278' },
      { tipo_tarjeta: 'CREDITO', cuenta_id: 2n, ultimos_4_digitos: '1927' }, // una de crédito NO aporta sus dígitos a la cuenta
    ];
    const aumentadas = cuentasConDebitos(cuentas, tarjetas);
    expect(aumentadas[0].ultimos_4_digitos).toBe('3698,7992,8949,4278');
    expect(aumentadas[1].ultimos_4_digitos).toBe('4248');
    expect(cuentas[0].ultimos_4_digitos).toBe('3698'); // la original no cambia
    expect(resolverCuenta(aumentadas, '7992')?.id).toBe(2n);
    expect(resolverCuenta(aumentadas, '1927')).toBeNull();
    expect(cuentasConDebitos(cuentas, [])).toBe(cuentas); // sin débitos no se copia nada
  });

  it('estado de los plásticos de una línea: ACTIVA, REEMPLAZADA (hay uno posterior) o INACTIVA (histórico sin continuidad)', () => {
    // Línea American Express del plan: 9587 → 0088 → 1927
    const amex = estadosDePlasticos([
      { id: 2, esActivo: false, vigenteDesde: '2022-01-04', vigenteHasta: '2024-03-16' },
      { id: 4, esActivo: false, vigenteDesde: '2024-03-20', vigenteHasta: '2024-06-04' },
      { id: 3, esActivo: true, vigenteDesde: '2024-12-27', vigenteHasta: null },
    ]);
    expect([...amex.entries()]).toEqual([[2, 'REEMPLAZADA'], [4, 'REEMPLAZADA'], [3, 'ACTIVA']]);

    // Un plástico histórico que fue el último de su línea no fue «reemplazado»
    const sola = estadosDePlasticos([{ id: 1, esActivo: false, vigenteDesde: '2021-01-01', vigenteHasta: '2022-01-01' }]);
    expect(sola.get(1)).toBe('INACTIVA');

    // El más antiguo sin fecha de inicio también queda reemplazado si hay otro con fecha
    const sinFecha = estadosDePlasticos([{ id: 1, esActivo: false, vigenteDesde: null, vigenteHasta: null }, { id: 2, esActivo: false, vigenteDesde: '2025-01-01', vigenteHasta: null }]);
    expect(sinFecha.get(1)).toBe('REEMPLAZADA');
    expect(sinFecha.get(2)).toBe('INACTIVA');

    // El vínculo explícito `reemplazaAId` cuenta aunque falten las fechas
    const porVinculo = estadosDePlasticos([{ id: 1, esActivo: false, vigenteDesde: null, vigenteHasta: null }, { id: 2, esActivo: false, vigenteDesde: null, vigenteHasta: null, reemplazaAId: 1 }]);
    expect(porVinculo.get(1)).toBe('REEMPLAZADA');
  });
});

describe('CrearTarjetaDto', () => {
  const validar = async (cuerpo: object) => (await validate(plainToInstance(CrearTarjetaDto, cuerpo))).flatMap((e) => Object.values(e.constraints ?? {}));

  it('acepta una de débito con cuenta, dígitos y fechas', async () => {
    expect(await validar({ tipo: 'DEBITO', cuentaId: 2, ultimos4: '7992', estado: 'ACTIVA', fechaInicioUso: '2026-09-19' })).toEqual([]);
  });

  it('rechaza un tipo desconocido, dígitos mal formados y fechas con otro formato', async () => {
    const errores = await validar({ tipo: 'PREPAGO', ultimos4: '79', fechaInicioUso: '19/09/2026', estado: 'HISTORICA' });
    expect(errores.length).toBe(4);
  });
});

describe('TarjetasService.crear (POST /api/tarjetas)', () => {
  function setup() {
    const prisma = createPrismaMock();
    const config = { get: () => undefined } as unknown as ConfigService;
    const linea = (extra: Record<string, unknown> = {}) => ({
      id: 20n, created_at: new Date('2026-10-16T10:00:00Z'), franquicia: 'Débito', descripcion: null, alias: null, tipo_tarjeta: 'DEBITO', cuenta_id: 2n, es_generica: false,
      tasa_interes_compra: null, tasa_interes_avance: null, cuota_manejo: null, url_info: null, ultima_actualizacion_tasas: null, extract_tasas: false, owner_user_id: OWNER,
      dia_corte: null, dia_limite_pago: null, cupo_total: null, permite_dolares: null, ultimos_4_digitos: null, plasticos: [], ...extra,
    });
    let creada = linea();
    prisma.tarjetas.create.mockImplementation(async ({ data }: any) => (creada = linea({ tipo_tarjeta: data.tipo_tarjeta, cuenta_id: data.cuenta_id, franquicia: data.franquicia, alias: data.alias, es_generica: data.es_generica })));
    prisma.tarjetas.findFirst.mockImplementation(async () => creada);
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 2n });
    prisma.tarjetaPlasticos.create.mockImplementation(async ({ data }: any) => ({ id: 90n, notas: null, motivo_reemplazo: null, reemplaza_a_id: null, vigente_desde: null, vigente_hasta: null, ...data }));
    prisma.tarjetaPlasticos.findMany.mockResolvedValue([{ id: 90n, ultimos_4: '7992', es_activo: true }]);
    return { prisma, service: new TarjetasService(prisma, new WebScrapingService(), config) };
  }

  it('una de débito exige la cuenta', async () => {
    const { service, prisma } = setup();
    await expect(service.crear({ tipo: 'DEBITO', ultimos4: '7992' }, OWNER)).rejects.toMatchObject({ status: 400 });
    expect(prisma.tarjetas.create).not.toHaveBeenCalled();
  });

  it('la cuenta debe ser del usuario (404 si no)', async () => {
    const { service, prisma } = setup();
    prisma.cuentasFinancieras.findFirst.mockResolvedValue(null);
    await expect(service.crear({ tipo: 'DEBITO', cuentaId: 99, ultimos4: '7992' }, OWNER)).rejects.toMatchObject({ status: 404 });
    expect(prisma.cuentasFinancieras.findFirst.mock.calls[0][0].where).toEqual({ id: 99n, owner_user_id: OWNER });
  });

  it('solo un producto «sin número» puede omitir los últimos 4', async () => {
    const { service, prisma } = setup();
    await expect(service.crear({ tipo: 'CREDITO' }, OWNER)).rejects.toMatchObject({ status: 400 });
    await service.crear({ tipo: 'CREDITO', esGenerica: true, alias: 'Crédito (sin número)' }, OWNER);
    expect(prisma.tarjetas.create.mock.calls[0][0].data).toMatchObject({ tipo_tarjeta: 'CREDITO', es_generica: true, alias: 'Crédito (sin número)', cuenta_id: null });
    expect(prisma.tarjetaPlasticos.create).not.toHaveBeenCalled();
  });

  it('crea la tarjeta de débito con su plástico vigente (inicio por defecto: hoy) y la cuenta', async () => {
    const { service, prisma } = setup();
    const r = await service.crear({ tipo: 'DEBITO', cuentaId: 2, ultimos4: '7992', alias: 'Débito *3698' }, OWNER);
    expect(prisma.tarjetas.create.mock.calls[0][0].data).toMatchObject({ owner_user_id: OWNER, tipo_tarjeta: 'DEBITO', cuenta_id: 2n, franquicia: 'Débito', alias: 'Débito *3698' });
    const plastico = prisma.tarjetaPlasticos.create.mock.calls[0][0].data;
    expect(plastico).toMatchObject({ tarjeta_id: 20n, ultimos_4: '7992', es_activo: true, vigente_hasta: null });
    expect(plastico.vigente_desde).toBeInstanceOf(Date);
    expect(r).toMatchObject({ id: 20, tipo: 'DEBITO', cuentaId: 2, alias: 'Débito *3698' });
  });

  it('una histórica entra sin ser el plástico vigente y con sus fechas', async () => {
    const { service, prisma } = setup();
    await service.crear({ tipo: 'CREDITO', ultimos4: '5052', estado: 'INACTIVA', fechaInicioUso: '2024-03-30', fechaFinUso: '2024-06-05', franquicia: 'Mastercard' }, OWNER);
    expect(prisma.tarjetaPlasticos.create.mock.calls[0][0].data).toMatchObject({ ultimos_4: '5052', es_activo: false, vigente_desde: utc('2024-03-30'), vigente_hasta: utc('2024-06-05') });
  });

  it('rechaza fechas incoherentes y fecha de fin en una activa', async () => {
    const { service } = setup();
    await expect(service.crear({ tipo: 'CREDITO', ultimos4: '5052', estado: 'INACTIVA', fechaInicioUso: '2024-06-05', fechaFinUso: '2024-03-30' }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(service.crear({ tipo: 'CREDITO', ultimos4: '5052', fechaFinUso: '2024-06-05' }, OWNER)).rejects.toMatchObject({ status: 400 });
  });

  it('no deja repetir dígitos que ya son de otra tarjeta o cuenta', async () => {
    const { service, prisma } = setup();
    prisma.tarjetas.findMany.mockResolvedValue([{ id: 1n, franquicia: 'Mastercard', descripcion: null, ultimos_4_digitos: '9491' }]);
    await expect(service.crear({ tipo: 'CREDITO', ultimos4: '9491' }, OWNER)).rejects.toMatchObject({ status: 409 });
    expect(prisma.tarjetas.create).not.toHaveBeenCalled();
  });

  it('una renovación entra en la línea del plástico anterior y lo archiva (no crea otra tarjeta)', async () => {
    const { service, prisma } = setup();
    prisma.tarjetaPlasticos.findFirst.mockResolvedValue({ tarjeta: { id: 20n, owner_user_id: OWNER, tipo_tarjeta: 'DEBITO' } });
    prisma.tarjetaPlasticos.findMany.mockResolvedValue([{ id: 80n, tarjeta_id: 20n, ultimos_4: '8949', es_activo: true, vigente_desde: utc('2025-01-05'), vigente_hasta: null, reemplaza_a_id: null }]);
    prisma.tarjetaPlasticos.findUniqueOrThrow.mockResolvedValue({ id: 80n, es_activo: false });
    await service.crear({ tipo: 'DEBITO', ultimos4: '7992', plasticoAnteriorId: 80, fechaInicioUso: '2026-09-19', motivo: 'CAMBIO_PRODUCTO' }, OWNER);
    expect(prisma.tarjetas.create).not.toHaveBeenCalled();
    expect(prisma.tarjetaPlasticos.update.mock.calls[0][0]).toMatchObject({ where: { id: 80n }, data: { es_activo: false, vigente_hasta: utc('2026-09-18') } });
    expect(prisma.tarjetaPlasticos.create.mock.calls[0][0].data).toMatchObject({ tarjeta_id: 20n, ultimos_4: '7992', es_activo: true, reemplaza_a_id: 80n, motivo_reemplazo: 'CAMBIO_PRODUCTO' });
  });

  it('la renovación debe ser del mismo tipo y no puede ser histórica', async () => {
    const { service, prisma } = setup();
    prisma.tarjetaPlasticos.findFirst.mockResolvedValue({ tarjeta: { id: 20n, owner_user_id: OWNER, tipo_tarjeta: 'DEBITO' } });
    await expect(service.crear({ tipo: 'CREDITO', ultimos4: '7992', plasticoAnteriorId: 80 }, OWNER)).rejects.toMatchObject({ status: 400 });
    await expect(service.crear({ tipo: 'DEBITO', ultimos4: '7992', plasticoAnteriorId: 80, estado: 'INACTIVA' }, OWNER)).rejects.toMatchObject({ status: 400 });
  });
});

describe('TarjetasService.actualizar — tipo y cuenta', () => {
  function setup(actual: Record<string, unknown>) {
    const prisma = createPrismaMock();
    const config = { get: () => undefined } as unknown as ConfigService;
    const base = { id: 4n, created_at: new Date(), franquicia: 'Visa', descripcion: null, alias: null, tipo_tarjeta: 'CREDITO', cuenta_id: null, es_generica: false, tasa_interes_compra: null, tasa_interes_avance: null, cuota_manejo: null, url_info: null, ultima_actualizacion_tasas: null, extract_tasas: false, owner_user_id: OWNER, dia_corte: null, dia_limite_pago: null, cupo_total: null, permite_dolares: null, ultimos_4_digitos: null, plasticos: [] };
    prisma.tarjetas.findFirst.mockResolvedValue({ ...base, ...actual });
    prisma.tarjetas.findUniqueOrThrow.mockResolvedValue({ ...base, ...actual });
    return { prisma, service: new TarjetasService(prisma, new WebScrapingService(), config) };
  }

  it('no pasa a débito una tarjeta con compras a crédito', async () => {
    const { service, prisma } = setup({});
    prisma.comprasCredito.count.mockResolvedValue(12);
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 2n });
    await expect(service.actualizar(4, { tipo: 'DEBITO', cuentaId: 2 }, OWNER)).rejects.toMatchObject({ status: 409 });
    expect(prisma.tarjetas.update).not.toHaveBeenCalled();
  });

  it('para pasar a débito sin compras exige la cuenta y la guarda', async () => {
    const { service, prisma } = setup({});
    await expect(service.actualizar(4, { tipo: 'DEBITO' }, OWNER)).rejects.toMatchObject({ status: 400 });
    prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 2n });
    await service.actualizar(4, { tipo: 'DEBITO', cuentaId: 2, alias: '  Débito  ' }, OWNER);
    expect(prisma.tarjetas.update.mock.calls[0][0].data).toMatchObject({ tipo_tarjeta: 'DEBITO', cuenta_id: 2n, alias: 'Débito' });
  });

  it('una de débito no puede quedarse sin cuenta; una de crédito sí', async () => {
    const debito = setup({ tipo_tarjeta: 'DEBITO', cuenta_id: 2n });
    await expect(debito.service.actualizar(4, { cuentaId: null }, OWNER)).rejects.toMatchObject({ status: 400 });
    const credito = setup({ cuenta_id: 2n });
    await credito.service.actualizar(4, { cuentaId: null }, OWNER);
    expect(credito.prisma.tarjetas.update.mock.calls[0][0].data).toMatchObject({ cuenta_id: null });
  });
});
