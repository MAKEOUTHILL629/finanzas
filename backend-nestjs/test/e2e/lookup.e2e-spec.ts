/* eslint-disable @typescript-eslint/no-explicit-any */
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { dec } from '../helpers/prisma-mock';
import { bearer, createTestApp, scalaStyleToken } from './app.helper';

/** Catálogos de los selectores: siempre 200 con arreglos, filtrados por el usuario del JWT y con la forma uniforme. */
describe('GET /api/lookup', () => {
  let app: NestExpressApplication;
  let prisma: any;
  let http: ReturnType<typeof request>;
  const auth = () => bearer(scalaStyleToken({ userId: 7 }));

  beforeEach(async () => {
    ({ app, prisma } = await createTestApp());
    http = request(app.getHttpServer());
    prisma.personas.findMany.mockResolvedValue([{ id: 1n, nombre: 'Felipe', iniciales_nombre: null, color_representativo: null, linked_user_id: 7n, email: null, numero_celular: null }]);
    prisma.cuentasFinancieras.findMany.mockResolvedValue([{ id: 3n, nombre: 'Ahorros', tipo_cuenta: 'AHORROS', banco_entidad: null, ultimos_4_digitos: '3698', moneda: 'COP', saldo_actual: dec('10.5'), is_active: true, es_principal: true }]);
  });
  afterEach(async () => {
    await app.close();
  });

  it('exige sesión', async () => {
    expect((await http.get('/api/lookup')).status).toBe(401);
  });

  it('devuelve los cuatro catálogos en una sola llamada, con ids numéricos y números como number', async () => {
    const res = await http.get('/api/lookup').set(auth());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['personas', 'tarjetas', 'cuentas', 'categorias']);
    expect(res.body.personas[0]).toMatchObject({ id: 1, nombre: 'Felipe', esPropia: true });
    expect(res.body.cuentas[0]).toMatchObject({ id: 3, saldoActual: 10.5, activa: true, esPrincipal: true });
    expect(res.body.tarjetas).toEqual([]);
    expect(prisma.personas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: 7n });
  });

  it('?tipos= limita lo que se consulta; un tipo desconocido es 400', async () => {
    const res = await http.get('/api/lookup?tipos=personas,cuentas').set(auth());
    expect(Object.keys(res.body)).toEqual(['personas', 'cuentas']);
    expect(prisma.tarjetas.findMany).not.toHaveBeenCalled();
    const mal = await http.get('/api/lookup?tipos=personas,gatos').set(auth());
    expect(mal.status).toBe(400);
    expect(mal.body.message).toBe('Datos inválidos');
  });

  it('/api/lookup/:tipo responde un arreglo plano; el alias /api/v2 funciona igual', async () => {
    const uno = await http.get('/api/lookup/personas').set(auth());
    expect(uno.status).toBe(200);
    expect(Array.isArray(uno.body)).toBe(true);
    expect((await http.get('/api/v2/lookup/cuentas').set(auth())).body[0]).toMatchObject({ id: 3, nombre: 'Ahorros' });
    expect((await http.get('/api/lookup/gatos').set(auth())).status).toBe(400);
    expect((await http.get('/api/lookup/personas,cuentas').set(auth())).status).toBe(400); // un solo tipo en la ruta
  });
});
