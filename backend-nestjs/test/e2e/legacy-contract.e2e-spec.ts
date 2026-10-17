/* eslint-disable @typescript-eslint/no-explicit-any */
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { dec, utc } from '../helpers/prisma-mock';
import { bearer, createTestApp, scalaStyleToken, TEST_SECRET } from './app.helper';

/**
 * Contrato HTTP legacy (Regla 6): códigos de estado, forma de los cuerpos, formato de fechas/números y
 * compatibilidad de los JWT emitidos por el backend Scala.
 */
describe('Contrato HTTP legacy', () => {
  let app: NestExpressApplication;
  let prisma: any;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    ({ app, prisma } = await createTestApp());
    http = request(app.getHttpServer());
  });
  afterEach(async () => {
    await app.close();
  });

  describe('JWT (compatibilidad con las sesiones activas de Angular)', () => {
    it('acepta un token con la forma exacta del emitido por Scala y toma userId como owner', async () => {
      prisma.tarjetas.findMany.mockResolvedValue([]);
      const res = await http.get('/api/tarjetas').set(bearer(scalaStyleToken({ userId: 42 })));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(prisma.tarjetas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: 42n });
    });

    it('token expirado → 401 "Invalid or expired token"', async () => {
      const res = await http.get('/api/tarjetas').set(bearer(scalaStyleToken({}, { expiresInSeconds: -60 })));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ status: 'error', message: 'Invalid or expired token' });
      expect(res.body.details).toBeDefined();
    });

    it('firma con otro secreto → 401', async () => {
      const res = await http.get('/api/tarjetas').set(bearer(scalaStyleToken({}, { secret: 'otro-secreto-distinto-123456' })));
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid or expired token');
    });

    it('algoritmo "none" y tokens malformados → 401', async () => {
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"userId":7}').toString('base64url')}.`;
      expect((await http.get('/api/tarjetas').set(bearer(none))).status).toBe(401);
      expect((await http.get('/api/tarjetas').set(bearer('abc.def.ghi'))).status).toBe(401);
    });

    it('sin header o sin esquema Bearer → 401 "Authorization header required"', async () => {
      const esperado = { status: 'error', message: 'Authorization header required' };
      expect((await http.get('/api/tarjetas')).body).toEqual(esperado);
      expect((await http.get('/api/tarjetas').set('Authorization', 'Basic abc')).body).toEqual(esperado);
    });

    it('token sin userId numérico → 401', async () => {
      const res = await http.get('/api/tarjetas').set(bearer(scalaStyleToken({ userId: undefined })));
      expect(res.status).toBe(401);
    });

    it('el preflight CORS (OPTIONS) no exige JWT y respeta los orígenes de application.conf', async () => {
      const res = await http
        .options('/api/compras-credito')
        .set('Origin', 'http://localhost:4200')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('PATCH');
      expect(res.headers['access-control-max-age']).toBe('3600');

      const noPermitido = await http.options('/api/compras-credito').set('Origin', 'http://evil.example').set('Access-Control-Request-Method', 'GET');
      expect(noPermitido.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Auth', () => {
    const usuario = (extra: Record<string, unknown> = {}) => ({
      id: 7n,
      email: 'felipe@example.com',
      password_hash: bcrypt.hashSync('secret123', 4),
      role: 'user',
      name: 'Felipe',
      avatar_url: null,
      is_active: true,
      ...extra,
    });

    it('login OK → 200 {status:"ok", token} y el token tiene los claims de Scala', async () => {
      prisma.users.findUnique.mockResolvedValue(usuario());
      const res = await http.post('/api/auth/login').send({ email: 'felipe@example.com', password: 'secret123' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');

      const claims = new JwtService({ secret: TEST_SECRET }).verify(res.body.token, { algorithms: ['HS256'] });
      expect(claims).toMatchObject({ userId: 7, email: 'felipe@example.com', role: 'user', name: 'Felipe', iss: 'Finanzas Makes' });
      expect(claims.exp - claims.iat).toBe(3600);
      expect(typeof claims.userId).toBe('number');

      // y ese token es aceptado de vuelta por el guard
      prisma.tarjetas.findMany.mockResolvedValue([]);
      expect((await http.get('/api/tarjetas').set(bearer(res.body.token))).status).toBe(200);
    });

    it('hash bcrypt "$2a$" generado por jBCrypt sigue siendo válido', async () => {
      const hash2a = bcrypt.hashSync('secret123', bcrypt.genSaltSync(4, 'a'));
      expect(hash2a.startsWith('$2a$')).toBe(true);
      prisma.users.findUnique.mockResolvedValue(usuario({ password_hash: hash2a }));
      expect((await http.post('/api/auth/login').send({ email: 'felipe@example.com', password: 'secret123' })).status).toBe(200);
    });

    it('credenciales inválidas → 401 con el mensaje legacy', async () => {
      prisma.users.findUnique.mockResolvedValue(usuario());
      const mala = await http.post('/api/auth/login').send({ email: 'felipe@example.com', password: 'otra' });
      expect(mala.status).toBe(401);
      expect(mala.body).toEqual({ status: 'error', message: 'Invalid email or password' });

      prisma.users.findUnique.mockResolvedValue(null);
      const noExiste = await http.post('/api/auth/login').send({ email: 'x@y.z', password: 'secret123' });
      expect(noExiste.body).toEqual({ status: 'error', message: 'Invalid email or password' });
    });

    it('cuenta social sin contraseña → 401 con mensaje específico', async () => {
      prisma.users.findUnique.mockResolvedValue(usuario({ password_hash: null }));
      const res = await http.post('/api/auth/login').send({ email: 'felipe@example.com', password: 'x' });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Password login not available for this account. Try social login.');
    });

    it('JSON inválido → 400 "Invalid JSON format" con details', async () => {
      const res = await http.post('/api/auth/login').send({ email: 'a@b.c' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', message: 'Invalid JSON format' });
      expect(res.body.details['obj.password']).toEqual([{ msg: ['error.path.missing'], args: [] }]);
    });

    it('register → 201 con el usuario (sin hash) e id real; 409 si el email existe; 400 si la clave es corta', async () => {
      prisma.users.findUnique.mockResolvedValue(null);
      prisma.users.create.mockImplementation(async ({ data }: any) => ({ id: 99n, avatar_url: null, ...data }));
      const ok = await http.post('/api/auth/register').send({ email: 'nuevo@example.com', password: 'longpassword', name: 'Nuevo' });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({
        status: 'ok',
        message: 'User registered successfully',
        user: { id: 99, email: 'nuevo@example.com', role: 'user', name: 'Nuevo', avatarUrl: null },
      });
      const guardado = prisma.users.create.mock.calls[0][0].data;
      expect(guardado.password_hash).not.toBe('longpassword');
      expect(bcrypt.compareSync('longpassword', guardado.password_hash)).toBe(true);

      prisma.users.findUnique.mockResolvedValue(usuario());
      const dup = await http.post('/api/auth/register').send({ email: 'felipe@example.com', password: 'longpassword' });
      expect(dup.status).toBe(409);
      expect(dup.body).toEqual({ status: 'error', message: 'Email already registered' });

      const corta = await http.post('/api/auth/register').send({ email: 'a@b.c', password: 'short' });
      expect(corta.status).toBe(400);
      expect(corta.body.message).toBe('Password must be at least 8 characters long');
    });

    it('token-is-valid y logout', async () => {
      prisma.users.findUnique.mockResolvedValue(usuario());
      const token = scalaStyleToken();
      expect((await http.get('/api/auth/token-is-valid').set(bearer(token))).body).toEqual({ status: 'ok' });
      expect((await http.get('/api/auth/token-is-valid').set('Authorization', 'Token abc')).status).toBe(400);
      expect((await http.get('/api/auth/token-is-valid').set(bearer('basura'))).body).toEqual({ status: 'error', message: 'Invalid token' });
      prisma.users.findUnique.mockResolvedValue(null);
      expect((await http.get('/api/auth/token-is-valid').set(bearer(token))).body).toEqual({ status: 'error', message: 'User not found' });

      const logout = await http.post('/api/auth/logout').set(bearer(token));
      expect(logout.status).toBe(204);
      expect(logout.text).toBe('');
    });

    it('callback OAuth → 501 con los parámetros recibidos', async () => {
      const res = await http.get('/api/auth/callback/google?code=abc&state=xyz');
      expect(res.status).toBe(501);
      expect(res.body).toEqual({
        status: 'pending',
        message: "OAuth callback for provider 'google' not yet implemented.",
        received_params: { code: ['abc'], state: ['xyz'] },
      });
    });
  });

  describe('Compras a crédito', () => {
    const compraDb = {
      id: 1n,
      created_at: new Date('2024-04-05T18:00:00Z'),
      concepto: 'Nevera',
      valor_compra: dec('2500000'),
      fecha_compra: utc('2024-04-05'),
      numero_cuotas: 36,
      fecha_ultima_cuota: utc('2027-04-30'),
      pago_mensual: dec('85000.5'),
      interes: dec('1.8895'),
      descripcion: 'Éxito',
      estado: 'Pendiente',
      tarjeta: 1n,
      owner_user_id: 7n,
      moneda_original: 'COP',
      valor_moneda_original: dec('2500000'),
      tasa_cambio_aplicada: dec('1'),
      trm_confirmada: true,
      responsables: [
        { persona: 2n, porcentaje_pago: dec('50') },
        { persona: 3n, porcentaje_pago: dec('25.5') },
      ],
    };

    it('GET /api/compras-credito → JSON legacy: fechas en epoch ms, montos como number, responsables "2,3"', async () => {
      prisma.comprasCredito.findMany.mockResolvedValue([compraDb]);
      const res = await http.get('/api/compras-credito').set(bearer());
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 1,
          fechaCreacion: 1712275200000,
          concepto: 'Nevera',
          valorCompra: 2500000,
          fechaCompra: 1712275200000,
          numeroCuotas: 36,
          fechaUltimaCuota: utc('2027-04-30').getTime(),
          pagoMensual: 85000.5,
          interes: 1.8895,
          descripcion: 'Éxito',
          estado: 'Pendiente',
          tarjeta: 1,
          responsables: '2,3',
          porcentajePago: 75.5,
          monedaOriginal: 'COP',
          valorMonedaOriginal: 2500000,
          tasaCambioAplicada: 1,
          trmConfirmada: true,
          plasticoId: null, // extras de sql/004: Angular los ignora
          plasticoUltimos4: null,
          refinanciamientoId: null,
          esRefinanciamiento: false,
          saldoRefinanciado: null,
          sistemaAmortizacion: 'CAPITAL_FIJO',
          cuotaFijaPactada: null,
        },
      ]);
      expect(prisma.comprasCredito.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: 7n });
    });

    it('GET /api/compras-credito/detalle/:id → objeto, o el literal null si no existe (200)', async () => {
      prisma.comprasCredito.findFirst.mockResolvedValue(compraDb);
      const ok = await http.get('/api/compras-credito/detalle/1').set(bearer());
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: 1, responsables: '', porcentajePago: 0 });

      prisma.comprasCredito.findFirst.mockResolvedValue(null);
      const nada = await http.get('/api/compras-credito/detalle/999').set(bearer());
      expect(nada.status).toBe(200);
      expect(nada.headers['content-type']).toContain('application/json');
      expect(nada.text).toBe('null');
    });

    it('POST /api/compras-credito → 200 (no 201) {message,id}', async () => {
      prisma.tarjetas.findFirst.mockResolvedValue({ id: 1n, dia_corte: null });
      prisma.comprasCredito.create.mockResolvedValue({ id: 321n });
      const res = await http.post('/api/compras-credito').set(bearer()).send({
        concepto: 'Nevera',
        valorCompra: 2500000,
        fechaCompra: '2024-04-05',
        numeroCuotas: 36,
        interes: 1.8895,
        descripcion: 'Éxito',
        estado: 'Pendiente',
        tarjeta: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Compra a crédito creada exitosamente', id: 321 });
      expect(prisma.cuotasDetalle.createMany.mock.calls[0][0].data).toHaveLength(36);
    });

    it('POST con datos inválidos → 400 {message:"Datos inválidos", errors}', async () => {
      const res = await http.post('/api/compras-credito').set(bearer()).send({ concepto: 'x', fechaCompra: '05/04/2024' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Datos inválidos');
      expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(['fechaCompra', 'numeroCuotas', 'interes', 'tarjeta']));
    });

    it('error de negocio → 500 {message:"Error al crear la compra a crédito: ..."}', async () => {
      prisma.tarjetas.findFirst.mockResolvedValue(null);
      const res = await http.post('/api/compras-credito').set(bearer()).send({
        concepto: 'x', valorCompra: 100, fechaCompra: '2024-04-05', numeroCuotas: 2, interes: 1, descripcion: 'd', estado: 'Pendiente', tarjeta: 9,
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: 'Error al crear la compra a crédito: No se encontró la tarjeta con ID 9' });
    });

    it('DELETE inexistente → 500 {message:"Error al eliminar la compra a crédito: ..."}; existente → 200', async () => {
      prisma.comprasCredito.findFirst.mockResolvedValue(null);
      const mal = await http.delete('/api/compras-credito/5').set(bearer());
      expect(mal.status).toBe(500);
      expect(mal.body).toEqual({ message: 'Error al eliminar la compra a crédito: No se encontró la compra con ID 5' });

      prisma.comprasCredito.findFirst.mockResolvedValue(compraDb);
      prisma.cuotasDetalle.findMany.mockResolvedValue([]);
      prisma.responsablesComprasCredito.findMany.mockResolvedValue([]);
      const ok = await http.delete('/api/compras-credito/1').set(bearer());
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ message: 'Compra a crédito eliminada exitosamente' });
    });

    it('PUT → 200 {message}; POST /api/recalcular-compra-credito → entero (filas afectadas)', async () => {
      prisma.comprasCredito.findFirst.mockResolvedValue(compraDb);
      prisma.tarjetas.findFirst.mockResolvedValue({ id: 1n });
      prisma.tarjetas.findUnique.mockResolvedValue({ dia_corte: null });
      prisma.comprasCredito.update.mockResolvedValue(compraDb);
      prisma.comprasCredito.updateMany.mockResolvedValue({ count: 1 });
      const body = { id: 1, concepto: 'Nevera', valorCompra: 2500000, fechaCompra: '2024-04-05', numeroCuotas: 36, interes: 1.8895, descripcion: 'd', estado: 'Pendiente', tarjeta: 1 };

      const put = await http.put('/api/compras-credito').set(bearer()).send(body);
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ message: 'Compra a crédito actualizada exitosamente' });

      const recalcular = await http.post('/api/recalcular-compra-credito').set(bearer()).send(body);
      expect(recalcular.status).toBe(200);
      expect(recalcular.text).toBe('1');
    });

    it('POST /api/compras-credito/pagar-productos → true; ajustar-interes → {message:"Estado cambiado"}', async () => {
      const pagar = await http.post('/api/compras-credito/pagar-productos').set(bearer());
      expect(pagar.status).toBe(200);
      expect(pagar.text).toBe('true');

      const ajuste = await http.post('/api/compras-credito/ajustar-interes-compras/1').set(bearer());
      expect(ajuste.status).toBe(200);
      expect(ajuste.body).toEqual({ message: 'Estado cambiado' });
    });

    it('GET /api/compras-credito/:id → cuotas con el formato CuotaDetalle', async () => {
      prisma.cuotasDetalle.findMany.mockResolvedValue([
        { id: 5n, numero_cuota: 1n, fecha_pago: utc('2024-04-30'), saldo_restante: dec('2430555.56'), interes_pagado: dec('0'), aporte_capital: dec('69444.44'), pago_total: dec('69444.44'), compra: 1n, estado: 'Pagado', periodo_facturacion: '2024-04' },
      ]);
      const res = await http.get('/api/compras-credito/1').set(bearer());
      expect(res.body).toEqual([
        { id: 5, numeroCuota: 1, fechaPago: 1714435200000, saldoRestante: 2430555.56, interesPagado: 0, aporteCapital: 69444.44, pagoTotal: 69444.44, compra: 1, estado: 'Pagado', periodoFacturacion: '2024-04' },
      ]);
    });

    it('un id no numérico → 400 (Play: "Cannot parse parameter id as Int")', async () => {
      expect((await http.get('/api/compras-credito/abc').set(bearer())).status).toBe(400);
      expect((await http.delete('/api/compras-credito/abc').set(bearer())).status).toBe(400);
    });
  });

  describe('CSV masivo', () => {
    it('sin archivo → 400 {message}', async () => {
      const res = await http.post('/api/compras-credito/upload-csv').set(bearer());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'No se encontró el archivo en la solicitud' });
    });

    it('con archivo → 200 text/csv descargable con la columna Resultado', async () => {
      prisma.tarjetas.findFirst.mockResolvedValue({ id: 1n, dia_corte: null });
      prisma.comprasCredito.create.mockResolvedValue({ id: 77n });
      const csv = 'Fecha Compra,Concepto,Valor,Cuotas,Tarjeta,Interes,descripcion,estado\n2024-01-15,Laptop,1500000,12,1,2.5,Trabajo,\n,,10,2,1,1,,\n';
      const res = await http.post('/api/compras-credito/upload-csv').set(bearer()).attach('file', Buffer.from(csv), 'compras.csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe('attachment; filename=resultado_compras.csv');
      const lineas = res.text.split('\r\n');
      expect(lineas[0]).toBe('Fecha Compra,Concepto,Valor,Cuotas,Tarjeta,Interes,Descripcion,Estado,Resultado');
      expect(lineas[1]).toContain('Éxito: Compra creada con ID 77');
      expect(lineas[2]).toContain('Error: Concepto es obligatorio');
    });
  });

  describe('Responsables, préstamos, pagos y tarjetas', () => {
    it('POST /api/compras-credito/responsables → 200 {message,id}; DELETE inexistente → 500', async () => {
      prisma.comprasCredito.findFirst.mockResolvedValue({ id: 1n });
      prisma.personas.findFirst.mockResolvedValue({ id: 2n });
      prisma.responsablesComprasCredito.create.mockResolvedValue({ id: 14n });
      const ok = await http.post('/api/compras-credito/responsables').set(bearer()).send({ persona: 2, porcentajePago: 50, cantidadPago: 42500, cantidadCuotas: 36, compraCredito: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ message: 'Responsable de compra a crédito creado exitosamente', id: 14 });

      const del = await http.delete('/api/compras-credito/responsables/99').set(bearer());
      expect(del.status).toBe(500);
      expect(del.body).toEqual({ message: 'Error al eliminar el responsable: No se encontró el responsable con ID 99' });
    });

    it('GET /api/prestamos y POST /api/prestamos', async () => {
      prisma.prestamos.findMany.mockResolvedValue([
        { id: 1n, created_at: new Date('2024-05-01T10:00:00Z'), valor_prestado: dec('500000'), concepto: 'Viaje', fecha_cobro: utc('2024-06-01'), responsable: 2n, estado: 'Pendiente', comentarios: '',
          direccion_prestamo: null, saldo_pendiente: null, es_recurrente_mensual: null, cuota_mensual_acordada: null, fecha_prestamo: null, metodo: null, corte_id: null, creado_por_persona_id: null, origen_cruce_aporte_id: null, aprobaciones: [] },
      ]);
      const lista = await http.get('/api/prestamos').set(bearer());
      expect(lista.body).toEqual([
        {
          // contrato legacy
          id: 1, fechaCreacion: 1714521600000, valorPrestado: 500000, concepto: 'Viaje', fechaCobro: 1717200000000, responsable: 2, estado: 'Pendiente', comentarios: '',
          // columnas Supabase + aprobaciones (superconjunto)
          direccionPrestamo: null, saldoPendiente: null, esRecurrenteMensual: null, cuotaMensualAcordada: null,
          fechaPrestamo: null, metodo: null, corteId: null, creadoPorPersonaId: null, origenCruceAporteId: null, aprobaciones: [],
        },
      ]);

      prisma.personas.findFirst.mockResolvedValue({ id: 2n });
      prisma.prestamos.create.mockResolvedValue({ id: 9n });
      const crea = await http.post('/api/prestamos').set(bearer()).send({ valorPrestado: 500000, concepto: 'Viaje', fechaCobro: '2024-06-01', responsable: 2, estado: 'Pendiente', comentarios: '' });
      expect(crea.status).toBe(200);
      expect(crea.body).toEqual({ message: 'Prestamo creado exitosamente', id: 9 });
    });

    it('GET /api/personas', async () => {
      prisma.personas.findMany.mockResolvedValue([{ id: 2n, nombre: 'María', created_at: new Date('2024-01-02T03:04:05Z'), iniciales_nombre: 'M', color_representativo: '#fff', email: null, numero_celular: null, linked_user_id: null }]);
      const res = await http.get('/api/personas').set(bearer());
      expect(res.body).toEqual([
        { id: 2, nombre: 'María', fechaCreacion: 1704153600000, inicialesNombre: 'M', colorRepresentativo: '#fff', email: null, numeroCelular: null, linkedUserId: null },
      ]);
    });

    it('GET /api/tarjetas/balance y /api/tarjetas/pagos/:id sin mes/year → 400 {message:"Datos inválidos"}', async () => {
      for (const ruta of ['/api/tarjetas/balance', '/api/tarjetas/pagos/1', '/api/tarjetas/balance?mes=4']) {
        const res = await http.get(ruta).set(bearer());
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Datos inválidos' });
      }
    });

    it('GET /api/tarjetas/pagos → [{valorPago,tarjeta,fechaPago}]', async () => {
      prisma.$queryRaw.mockResolvedValue([{ tarjeta: 1n, fecha_pago: utc('2024-04-30'), valor_pago: dec('450000') }]);
      const res = await http.get('/api/tarjetas/pagos').set(bearer());
      expect(res.body).toEqual([{ valorPago: 450000, tarjeta: 1, fechaPago: 1714435200000 }]);
    });

    it('GET /api/pagos/personas → fecha MM/dd/yyyy y valorPago number', async () => {
      prisma.$queryRaw.mockResolvedValue([{ persona_id: 2n, mes_pago: utc('2024-04-30'), total_pago_responsable: dec('320000.25') }]);
      const res = await http.get('/api/pagos/personas').set(bearer());
      expect(res.body).toEqual([{ persona: 2, fecha: '04/30/2024', valorPago: 320000.25 }]);
    });

    it('POST /api/tarjetas/actualizar-tasas sin tarjetas → 200 con mensaje legacy; /:id inexistente → 404 {mensaje}', async () => {
      prisma.tarjetas.findMany.mockResolvedValue([]);
      const todas = await http.post('/api/tarjetas/actualizar-tasas').set(bearer());
      expect(todas.status).toBe(200);
      expect(todas.body.total).toBe(0);

      prisma.tarjetas.findFirst.mockResolvedValue(null);
      const una = await http.post('/api/tarjetas/4/actualizar-tasas').set(bearer());
      expect(una.status).toBe(404);
      expect(una.body).toEqual({ mensaje: 'No se encontró la tarjeta con id=4' });
    });
  });

  describe('Rutas v2: BigInt y Decimal llegan como number', () => {
    it('GET /api/cuentas-financieras (y el alias /api/v2/cuentas-financieras)', async () => {
      prisma.cuentasFinancieras.findMany.mockResolvedValue([
        { id: 3n, owner_user_id: 7n, nombre: 'Nequi', tipo_cuenta: 'BILLETERA_DIGITAL', moneda: 'COP', saldo_actual: dec('1250000.75'), is_active: true, created_at: new Date('2026-10-01T00:00:00Z') },
      ]);
      const res = await http.get('/api/cuentas-financieras').set(bearer());
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ id: 3, owner_user_id: 7, saldo_actual: 1250000.75, created_at: '2026-10-01T00:00:00.000Z' });
      const alias = await http.get('/api/v2/cuentas-financieras').set(bearer());
      expect(alias.body).toEqual(res.body);
    });

    it('validación v2: enum inválido → 400 {message:"Datos inválidos", errors}', async () => {
      const res = await http.post('/api/transacciones').set(bearer()).send({ tipoTransaccion: 'ROBO', concepto: 'x', montoOriginal: 10 });
      expect(res.status).toBe(400);
      expect(res.body.errors.tipoTransaccion[0]).toContain('tipoTransaccion must be one of');
    });

    it('GET /api/v2/subledger/estado-cuenta exige periodo; con periodo devuelve montos como number', async () => {
      const sin = await http.get('/api/ledger/estado-cuenta').set(bearer());
      expect(sin.status).toBe(400);
      prisma.$queryRaw.mockResolvedValue([{ persona_id: 2n, nombre: 'Andrés', saldo_neto_mes: dec('-1500.5'), saldo_total_acumulado: dec('900000') }]);
      const ok = await http.get('/api/ledger/estado-cuenta?periodo=2026-10').set(bearer());
      expect(ok.body).toEqual([{ persona_id: 2, nombre: 'Andrés', saldo_neto_mes: -1500.5, saldo_total_acumulado: 900000 }]);
    });

    it('PATCH confirmar-trm y POST pagar-extracto pasan por los stored procedures', async () => {
      prisma.comprasCredito.findFirst.mockResolvedValue({ id: 1n, moneda_original: 'USD', owner_user_id: 7n, created_at: new Date(), valor_compra: dec('420000') });
      const trm = await http.patch('/api/compras-credito/1/confirmar-trm').set(bearer()).send({ nuevaTrm: '4150.00' });
      expect(trm.status).toBe(200);
      expect(prisma.$executeRaw).toHaveBeenCalled();

      prisma.tarjetas.findFirst.mockResolvedValue({ id: 4n });
      prisma.cuentasFinancieras.findFirst.mockResolvedValue({ id: 3n });
      prisma.$queryRaw.mockResolvedValue([{ transaccion_id: 901n }]);
      const pago = await http.post('/api/tarjetas/4/pagar-extracto').set(bearer()).send({ cuentaOrigenId: 3, periodo: '2026-10', montoPagado: '1250000.50' });
      expect(pago.status).toBe(200);
      expect(pago.body).toMatchObject({ transaccionId: 901, montoPagado: 1250000.5 });
    });
  });
});
