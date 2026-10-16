/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarTarjetaDto } from '../src/modules/tarjetas/dto/actualizar-tarjeta.dto';
import { TarjetasService } from '../src/modules/tarjetas/tarjetas.service';
import { WebScrapingService } from '../src/modules/tarjetas/web-scraping.service';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 7n;

function tarjeta(extra: Record<string, unknown> = {}) {
  return {
    id: 4n,
    created_at: new Date('2026-01-02T10:00:00Z'),
    franquicia: 'Visa',
    descripcion: 'Oro',
    tasa_interes_compra: dec('1.8895'),
    tasa_interes_avance: null,
    cuota_manejo: null,
    url_info: null,
    ultima_actualizacion_tasas: null,
    extract_tasas: false,
    owner_user_id: OWNER,
    dia_corte: null,
    dia_limite_pago: null,
    cupo_total: null,
    permite_dolares: null,
    ...extra,
  };
}

describe('TarjetasService.actualizar (PUT /api/tarjetas/:id)', () => {
  function setup() {
    const prisma = createPrismaMock();
    const config = { get: () => undefined } as unknown as ConfigService;
    let ultimo: any = null;
    prisma.tarjetas.update.mockImplementation(async ({ data }: any) => (ultimo = tarjeta(data)));
    // Tras guardar, el servicio vuelve a leer la tarjeta con sus plásticos.
    prisma.tarjetas.findUniqueOrThrow.mockImplementation(async () => ({ ...(ultimo ?? (await prisma.tarjetas.findFirst.mock.results[0].value)), plasticos: [] }));
    return { prisma, service: new TarjetasService(prisma, new WebScrapingService(), config) };
  }

  it('solo escribe los campos recibidos, con decimales exactos', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(tarjeta());

    await service.actualizar(4, { diaCorte: 15, diaLimitePago: 5, cupoTotal: '12000000.505', tasaInteresCompra: '1.88955', cuotaManejo: 25000 }, OWNER);

    const { where, data } = prisma.tarjetas.update.mock.calls[0][0];
    expect(where).toEqual({ id: 4n });
    expect(Object.keys(data).sort()).toEqual(['cuota_manejo', 'cupo_total', 'dia_corte', 'dia_limite_pago', 'tasa_interes_compra']);
    expect(data.dia_corte).toBe(15);
    expect(data.cupo_total.toString()).toBe('12000000.51'); // 2 decimales, HALF_UP
    expect(data.tasa_interes_compra.toString()).toBe('1.8896'); // 4 decimales, HALF_UP
    expect(data.cuota_manejo.toString()).toBe('25000');
  });

  it('verifica la propiedad: una tarjeta de otro usuario es 404 y no se escribe nada', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(null);
    await expect(service.actualizar(4, { diaCorte: 10 }, OWNER)).rejects.toMatchObject({ status: 404 });
    expect(prisma.tarjetas.findFirst.mock.calls[0][0].where).toEqual({ id: 4n, owner_user_id: OWNER });
    expect(prisma.tarjetas.update).not.toHaveBeenCalled();
  });

  it('un cuerpo vacío no escribe y devuelve la tarjeta tal cual', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(tarjeta({ dia_corte: 20 }));
    const r = await service.actualizar(4, {}, OWNER);
    expect(prisma.tarjetas.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ id: 4, diaCorte: 20 });
  });

  it('devuelve la misma forma JSON que GET /api/tarjetas (decimales como number)', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(tarjeta());
    const r = await service.actualizar(4, { cupoTotal: '5000000', permiteDolares: true, urlInfo: '  https://banco.example/tarifas  ' }, OWNER);
    expect(r).toMatchObject({ id: 4, franquicia: 'Visa', tasaInteresCompra: 1.8895, tasaInteresAvance: null, permiteDolares: true, urlInfo: 'https://banco.example/tarifas' });
    expect(typeof r.id).toBe('number');
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(['id', 'franquicia', 'descripcion', 'fechaCreacion', 'diaCorte', 'diaLimitePago', 'cupoTotal', 'permiteDolares', 'extractTasas']),
    );
  });

  it('urlInfo vacío limpia el campo', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findFirst.mockResolvedValue(tarjeta({ url_info: 'https://x' }));
    await service.actualizar(4, { urlInfo: '   ' }, OWNER);
    expect(prisma.tarjetas.update.mock.calls[0][0].data.url_info).toBeNull();
  });
});

describe('ActualizarTarjetaDto (validación)', () => {
  const errores = async (obj: Record<string, unknown>) =>
    (await validate(plainToInstance(ActualizarTarjetaDto, obj))).map((e) => e.property).sort();

  it('acepta un cuerpo válido y uno vacío', async () => {
    expect(await errores({})).toEqual([]);
    expect(await errores({ diaCorte: 31, diaLimitePago: 1, cupoTotal: '1500000.50', tasaInteresCompra: 0, permiteDolares: false })).toEqual([]);
  });

  it('rechaza días fuera de 1-31, no enteros y montos mal formados', async () => {
    expect(await errores({ diaCorte: 0 })).toEqual(['diaCorte']);
    expect(await errores({ diaCorte: 32 })).toEqual(['diaCorte']);
    expect(await errores({ diaLimitePago: 5.5 })).toEqual(['diaLimitePago']);
    expect(await errores({ cupoTotal: 0 })).toEqual(['cupoTotal']); // el cupo debe ser > 0
    expect(await errores({ cupoTotal: '10.123' })).toEqual(['cupoTotal']);
    expect(await errores({ tasaInteresCompra: '1.23456' })).toEqual(['tasaInteresCompra']);
    expect(await errores({ tasaInteresAvance: -1 })).toEqual(['tasaInteresAvance']);
    expect(await errores({ cuotaManejo: 'abc' })).toEqual(['cuotaManejo']);
    expect(await errores({ permiteDolares: 'si' })).toEqual(['permiteDolares']);
  });
});
