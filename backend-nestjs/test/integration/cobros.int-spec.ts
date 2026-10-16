/* eslint-disable @typescript-eslint/no-explicit-any */
import { serializeForJson } from '../../src/common/interceptors/json-serialization.interceptor';
import { CobroPublicoService } from '../../src/modules/cobros/cobro-publico.service';
import { NotificacionItemDto } from '../../src/modules/notificaciones-correo/dto/sync-batch.dto';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Cobros a personas contra PostgreSQL real: gastos repartidos (luz, mercado, fiestas), liquidación con detalle, enlace público,
 * pagos reportados con comprobante y su aprobación/rechazo, y el saldo que pasa al siguiente cierre.
 */
describeDb('Integración BD — cobros a personas', () => {
  let s: Servicios;
  let semilla: Semilla;
  const PERIODO = '2026-10';
  const SIGUIENTE = '2026-11';

  beforeAll(async () => {
    await prepararEsquema();
    s = await crearServicios();
  });
  afterAll(async () => {
    await s.prisma.$disconnect();
  });
  beforeEach(async () => {
    await vaciarTablas();
    semilla = await sembrar(s.prisma);
  });

  // PNG de 1×1 y un PDF mínimo: lo justo para pasar la validación por firma del archivo
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF').toString('base64');

  const cobro = (extra: Record<string, unknown> = {}) =>
    ({
      concepto: 'Recibo de la luz',
      categoria: 'SERVICIO',
      fechaGasto: '2026-10-14',
      montoTotal: 184500,
      modoDivision: 'IGUAL',
      participantes: [{ personaId: semilla.yoId }, { personaId: semilla.andresId }, { personaId: semilla.papaId }],
      ...extra,
    }) as any;

  const liqAndres = (periodo = PERIODO) => s.liquidacion.liquidacionPersona(periodo, semilla.andresId, semilla.userId);
  const tokenDe = async (dto: Record<string, unknown> = {}) =>
    (await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO, ...dto } as any, semilla.userId)).token;
  const reportar = (token: string, extra: Record<string, unknown> = {}) =>
    s.cobroPublico.reportar(token, { monto: 100000, fechaPago: new Date().toISOString().slice(0, 10), medio: 'BREB', ...extra } as any);

  describe('cobros puntuales (luz, mercado, eventos)', () => {
    it('IGUAL: el gasto se divide entre quienes participan (el propietario incluido) y cada tercero recibe su cargo', async () => {
      const c = await s.cobrosPuntuales.crear(cobro(), semilla.userId);

      expect(c).toMatchObject({ estado: 'ACTIVO', periodo: PERIODO, categoria: 'SERVICIO' });
      expect(c.participantes.map((p) => [Number(p.personaId), p.monto.toString(), p.esPropio])).toEqual([
        [semilla.yoId, '61500', true],
        [semilla.andresId, '61500', false],
        [semilla.papaId, '61500', false],
      ]);
      expect(c.montoACobrar.toString()).toBe('123000');
      expect(c.parteDelPropietario.toString()).toBe('61500');

      const cargos = await s.prisma.movimientosDeudaPersona.findMany({ where: { tipo_movimiento: 'CARGO_COBRO_PUNTUAL' }, orderBy: { persona_id: 'asc' } });
      expect(cargos.map((m) => [Number(m.persona_id), m.monto.toString(), m.signo, m.estado, m.periodo_imputacion])).toEqual([
        [semilla.andresId, '61500', 1, 'CONFIRMADO', PERIODO],
        [semilla.papaId, '61500', 1, 'CONFIRMADO', PERIODO],
      ]);

      const l = await liqAndres();
      expect(l.cobrosPuntuales.items).toHaveLength(1);
      expect(l.cobrosPuntuales.items[0]).toMatchObject({ concepto: 'Recibo de la luz', origen: 'COBRO_PUNTUAL' });
      expect(l.cobrosPuntuales.items[0].detalle).toMatchObject({ tipo: 'COBRO_PUNTUAL', categoria: 'SERVICIO', modoDivision: 'IGUAL' });
      expect(l.cobrosPuntuales.subtotal.toString()).toBe('61500');
      expect(l.resumenNeto.saldoNetoFinal.toString()).toBe('61500');
    });

    it('IGUAL reparte los centavos sobrantes para que la suma sea EXACTAMENTE el total', async () => {
      const c = await s.cobrosPuntuales.crear(cobro({ montoTotal: 100, participantes: [{ personaId: semilla.andresId }, { personaId: semilla.papaId }, { personaId: semilla.yoId }] }), semilla.userId);
      expect(c.participantes.map((p) => p.monto.toString())).toEqual(['33.34', '33.33', '33.33']);
      const suma = c.participantes.reduce((acc, p) => acc + Number(p.monto), 0);
      expect(suma).toBeCloseTo(100, 2);
    });

    it('PORCENTAJE y MONTO: lo que no se reparte queda para el propietario', async () => {
      const pct = await s.cobrosPuntuales.crear(
        cobro({ concepto: 'Mercado', categoria: 'MERCADO', modoDivision: 'PORCENTAJE', montoTotal: 200000, participantes: [{ personaId: semilla.andresId, porcentaje: 30 }, { personaId: semilla.papaId, porcentaje: 20 }] }),
        semilla.userId,
      );
      expect(pct.participantes.map((p) => p.monto.toString())).toEqual(['60000', '40000']);
      expect(pct.parteDelPropietario.toString()).toBe('100000');

      const monto = await s.cobrosPuntuales.crear(
        cobro({ concepto: 'Fiesta', categoria: 'EVENTO', modoDivision: 'MONTO', montoTotal: 500000, participantes: [{ personaId: semilla.andresId, monto: 150000 }, { personaId: semilla.papaId, monto: 100000.5 }] }),
        semilla.userId,
      );
      expect(monto.montoACobrar.toString()).toBe('250000.5');
      expect(monto.parteDelPropietario.toString()).toBe('249999.5');
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('210000'); // 60.000 + 150.000
    });

    it('rechaza repartos inválidos (porcentajes > 100 %, montos que superan el total, personas repetidas o ajenas)', async () => {
      const mala = (extra: Record<string, unknown>) => s.cobrosPuntuales.crear(cobro(extra), semilla.userId);
      await expect(mala({ modoDivision: 'PORCENTAJE', participantes: [{ personaId: semilla.andresId, porcentaje: 70 }, { personaId: semilla.papaId, porcentaje: 40 }] })).rejects.toMatchObject({ status: 400 });
      await expect(mala({ modoDivision: 'MONTO', participantes: [{ personaId: semilla.andresId, monto: 200000 }] })).rejects.toMatchObject({ status: 400 });
      await expect(mala({ modoDivision: 'PORCENTAJE', participantes: [{ personaId: semilla.andresId }] })).rejects.toMatchObject({ status: 400 });
      await expect(mala({ participantes: [{ personaId: semilla.andresId }, { personaId: semilla.andresId }] })).rejects.toMatchObject({ status: 400 });
      await expect(mala({ participantes: [{ personaId: 99999 }] })).rejects.toMatchObject({ status: 404 });
      await expect(mala({ fechaGasto: '2026-13-45' })).rejects.toMatchObject({ status: 400 });
      await expect(mala({ transaccionId: 99999 })).rejects.toMatchObject({ status: 400 });
      expect(await s.prisma.cobrosPuntuales.count()).toBe(0);
      expect(await s.prisma.movimientosDeudaPersona.count()).toBe(0);
    });

    it('editar rehace los cargos; anular los saca de la liquidación pero los conserva para auditar', async () => {
      const c = await s.cobrosPuntuales.crear(cobro(), semilla.userId);
      const editado = await s.cobrosPuntuales.actualizar(Number(c.id), cobro({ montoTotal: 90000, participantes: [{ personaId: semilla.andresId }] }), semilla.userId);
      expect(editado.participantes).toHaveLength(1);
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('90000');
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { persona_id: BigInt(semilla.papaId) } })).toBe(0);

      const anulado = await s.cobrosPuntuales.anular(Number(c.id), semilla.userId);
      expect(anulado.estado).toBe('ANULADO');
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('0');
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { cobro_puntual_id: c.id, estado: 'ANULADO' } })).toBe(1);
      await expect(s.cobrosPuntuales.actualizar(Number(c.id), cobro(), semilla.userId)).rejects.toMatchObject({ status: 409 });
      expect((await s.cobrosPuntuales.listar(semilla.userId, { periodo: PERIODO })).length).toBe(0);
      expect((await s.cobrosPuntuales.listar(semilla.userId, { periodo: PERIODO, estado: 'TODOS' })).length).toBe(1);
    });

    it('multi-tenant: nadie ve ni toca los cobros de otro usuario', async () => {
      const c = await s.cobrosPuntuales.crear(cobro(), semilla.userId);
      const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
      await expect(s.cobrosPuntuales.obtener(Number(c.id), otro.id)).rejects.toMatchObject({ status: 404 });
      await expect(s.cobrosPuntuales.anular(Number(c.id), otro.id)).rejects.toMatchObject({ status: 404 });
      expect(await s.cobrosPuntuales.listar(otro.id)).toEqual([]);
    });
  });

  describe('liquidación: detalle de las cuotas de tarjeta', () => {
    it('cada cuota dice de qué compra es, qué porcentaje y cuántas cuotas le tocan a la persona', async () => {
      const id = await s.compras.save(
        { concepto: 'Nevera', valorCompra: 600000, fechaCompra: '2026-10-05', numeroCuotas: 3, interes: 0, descripcion: 'x', estado: 'Pendiente', tarjeta: semilla.tarjetaId },
        semilla.userId,
      );
      await s.responsables.create({ persona: semilla.andresId, porcentajePago: 50, cantidadPago: 300000, cantidadCuotas: 2, compraCredito: id } as any, semilla.userId);

      const l = await liqAndres();
      const cuota = l.cuotasTarjetas.items[0];
      expect(cuota.origen).toBe('COMPRA_CREDITO');
      expect(cuota.detalle).toMatchObject({
        tipo: 'CUOTA_TARJETA',
        compra: 'Nevera',
        numeroCuota: 1,
        cuotasDeLaCompra: 3,
        cuotasQueTePertenecen: 2,
        tarjeta: 'Visa · Visa Oro',
      });
      expect((cuota.detalle as any).porcentaje.toString()).toBe('50');
      expect((cuota.detalle as any).valorCompra.toString()).toBe('600000');
      expect(cuota.monto.toString()).toBe('100000'); // 50 % de la cuota 1 de 200.000
    });
  });

  describe('enlace público', () => {
    it('genera un enlace con un token largo y aleatorio, y guarda SOLO la liquidación de esa persona', async () => {
      await s.cobrosPuntuales.crear(cobro(), semilla.userId);
      const e = await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO, mensaje: 'Hola', instruccionesPago: 'Bre-B @luish9910' } as any, semilla.userId);

      expect(e.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(e).toMatchObject({ ruta: `/p/${e.token}`, vigente: true, revocado: false, persona: 'Andrés', mensaje: 'Hola', reportesPendientes: 0 });
      expect(e.resumen?.saldoNetoFinal).toBe(61500);

      const vista: any = await s.cobroPublico.ver(e.token);
      expect(vista).toMatchObject({ periodo: PERIODO, persona: { nombre: 'Andrés' }, propietario: { nombre: 'Felipe' }, instruccionesPago: 'Bre-B @luish9910', reportes: [] });
      expect(vista.bloques.map((b: any) => b.clave)).toEqual(['cobrosPuntuales']);
      expect(vista.bloques[0].items[0]).toMatchObject({ concepto: 'Recibo de la luz', monto: 61500, fecha: '2026-10-14' });
      expect(vista.resumen).toMatchObject({ saldoNetoFinal: 61500, estado: 'DEBE', saldoAnterior: 0 });
      // nada de la otra persona (Papá) aparece en lo que ve Andrés
      expect(JSON.stringify(vista)).not.toContain('Papá');
      expect((await s.prisma.enlacesCobroPersona.findFirstOrThrow()).vistas).toBe(1);
    });

    it('regenerar conserva el mismo enlace y lo actualiza; rotarToken lo cambia; revocar lo desactiva sin revelar por qué', async () => {
      const t1 = await tokenDe();
      await s.cobrosPuntuales.crear(cobro(), semilla.userId);
      const e2 = await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId);
      expect(e2.token).toBe(t1);
      expect(((await s.cobroPublico.ver(t1)) as any).resumen.saldoNetoFinal).toBe(61500); // la foto se actualizó
      expect(await s.prisma.enlacesCobroPersona.count()).toBe(1);

      const e3 = await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO, rotarToken: true } as any, semilla.userId);
      expect(e3.token).not.toBe(t1);
      await expect(s.cobroPublico.ver(t1)).rejects.toMatchObject({ status: 404 });

      await s.enlacesCobro.revocar(Number(e3.id), semilla.userId);
      await expect(s.cobroPublico.ver(e3.token)).rejects.toMatchObject({ status: 404 });
      await expect(s.cobroPublico.ver('token-que-no-existe-0123456789')).rejects.toMatchObject({ status: 404 });
      await expect(s.cobroPublico.ver('x')).rejects.toMatchObject({ status: 404 });
      // generarlo otra vez lo reactiva
      expect((await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId)).vigente).toBe(true);
    });

    it('un enlace vencido deja de funcionar', async () => {
      const t = await tokenDe();
      await s.prisma.enlacesCobroPersona.updateMany({ data: { expira_at: new Date(Date.now() - 1000) } });
      await expect(s.cobroPublico.ver(t)).rejects.toMatchObject({ status: 404 });
    });

    it('valida vigencia y pertenencia', async () => {
      await expect(s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: '2026-13' } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO, diasVigencia: 999 } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.enlacesCobro.generar({ personaId: 9999, periodo: PERIODO } as any, semilla.userId)).rejects.toMatchObject({ status: 404 });
      const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
      await expect(s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO } as any, otro.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('pago reportado con comprobante', () => {
    beforeEach(async () => {
      await s.cobrosPuntuales.crear(cobro(), semilla.userId); // Andrés debe 61.500
    });

    it('la persona reporta con comprobante; solo el propietario ve el archivo; ella ve el estado sin los bytes', async () => {
      const t = await tokenDe();
      const r = await reportar(t, { monto: 61500, referencia: 'ABC123', comentario: 'Listo', comprobante: { nombre: 'C:\\fakepath\\../pago final.png', tipo: 'image/png', datos: PNG } });
      expect(r).toMatchObject({ estado: 'PENDIENTE' });

      const lista = await s.reportesPago.listar(semilla.userId, { estado: 'PENDIENTE' });
      expect(lista).toHaveLength(1);
      expect(lista[0]).toMatchObject({ persona: 'Andrés', referencia: 'ABC123', tieneComprobante: true, comprobanteTipo: 'image/png', estado: 'PENDIENTE', correoCoincidente: null });
      expect(lista[0].comprobanteNombre).toBe('pago final.png'); // nombre saneado: sin ruta ni caracteres peligrosos
      expect(lista[0]).not.toHaveProperty('comprobante');

      const archivo = await s.reportesPago.comprobante(Number(lista[0].id), semilla.userId);
      expect(archivo.tipo).toBe('image/png');
      expect(archivo.datos.toString('base64')).toBe(PNG);
      const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
      await expect(s.reportesPago.comprobante(Number(lista[0].id), otro.id)).rejects.toMatchObject({ status: 404 });
      expect(await s.reportesPago.listar(otro.id)).toEqual([]);

      const publico: any = await s.cobroPublico.ver(t);
      expect(publico.reportes).toHaveLength(1);
      expect(publico.reportes[0]).toMatchObject({ estado: 'PENDIENTE', conComprobante: true });
      expect(Number(publico.reportes[0].monto)).toBe(61500);
      expect(JSON.stringify(serializeForJson(publico))).not.toContain(PNG);
      expect((await s.enlacesCobro.listar(semilla.userId))[0].reportesPendientes).toBe(1);
    });

    it('rechaza comprobantes con tipo falso, formato no permitido, vacíos o demasiado grandes; y reportes inválidos', async () => {
      const t = await tokenDe();
      // validación aparte del ritmo: instancia propia del servicio público
      const publico = new CobroPublicoService(s.prisma);
      const reportar = (token: string, extra: Record<string, unknown> = {}) =>
        publico.reportar(token, { monto: 100000, fechaPago: new Date().toISOString().slice(0, 10), medio: 'BREB', ...extra } as any);
      const falso = Buffer.from('MZ este-es-un-ejecutable-disfrazado').toString('base64');
      await expect(reportar(t, { comprobante: { nombre: 'a.png', tipo: 'image/png', datos: falso } })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { comprobante: { nombre: 'a.png', tipo: 'image/png', datos: PDF } })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { comprobante: { nombre: 'a.exe', tipo: 'application/x-msdownload', datos: PNG } })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { comprobante: { nombre: 'a.png', tipo: 'image/png', datos: '!!!no-es-base64!!!' } })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { comprobante: { nombre: 'a.png', tipo: 'image/png', datos: '' } })).rejects.toMatchObject({ status: 400 });
      const grande = Buffer.concat([Buffer.from(PNG, 'base64').subarray(0, 8), Buffer.alloc(2_500_000)]).toString('base64');
      await expect(reportar(t, { comprobante: { nombre: 'a.png', tipo: 'image/png', datos: grande } })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { monto: -5 })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { monto: 5_000_000_000 })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { fechaPago: '2099-01-01' })).rejects.toMatchObject({ status: 400 });
      await expect(reportar(t, { fechaPago: '2020-01-01' })).rejects.toMatchObject({ status: 400 });
      expect(await s.prisma.reportesPagoPersona.count()).toBe(0);
      // un PDF sí es válido
      await expect(reportar(t, { comprobante: { nombre: 'recibo.pdf', tipo: 'application/pdf', datos: PDF } })).resolves.toMatchObject({ estado: 'PENDIENTE' });
    });

    it('límites: pocos reportes pendientes por enlace y ritmo máximo por minuto', async () => {
      const t = await tokenDe();
      for (let i = 0; i < 12; i++) await expect(reportar(t, { monto: -1 })).rejects.toMatchObject({ status: 400 }); // también cuentan los intentos inválidos
      await expect(reportar(t)).rejects.toMatchObject({ status: 429 }); // el 13.º en 10 min
      const t2 = await tokenDe({ periodo: SIGUIENTE });
      await s.prisma.reportesPagoPersona.createMany({
        data: Array.from({ length: 8 }, () => ({ owner_user_id: semilla.userId, persona_id: BigInt(semilla.andresId), periodo: SIGUIENTE, monto_reportado: '1000', fecha_pago: new Date(), enlace_id: null })),
      });
      const enlace2 = await s.prisma.enlacesCobroPersona.findFirstOrThrow({ where: { token: t2 } });
      await s.prisma.reportesPagoPersona.updateMany({ where: { periodo: SIGUIENTE }, data: { enlace_id: enlace2.id } });
      await expect(reportar(t2)).rejects.toMatchObject({ status: 409 });
    });

    it('APROBAR con cuenta destino: crea el ingreso (mueve el saldo), abona la deuda y actualiza lo que ve la persona', async () => {
      const t = await tokenDe();
      await reportar(t, { monto: 40000 });
      const [rep] = await s.reportesPago.listar(semilla.userId, { estado: 'PENDIENTE' });

      const r = await s.reportesPago.aprobar(Number(rep.id), { cuentaDestinoId: semilla.bancolombiaId }, semilla.userId);

      expect(r).toMatchObject({ estado: 'APROBADO' });
      expect(r.monto.toString()).toBe('40000');
      const ingreso = await s.prisma.transacciones.findFirstOrThrow({ where: { tipo_transaccion: 'REEMBOLSO_TERCERO' } }); // lo crea sp_registrar_abono_persona
      expect(ingreso).toMatchObject({ cuenta_destino_id: BigInt(semilla.bancolombiaId), estado: 'CONFIRMADO' });
      expect((await s.prisma.cuentasFinancieras.findUniqueOrThrow({ where: { id: BigInt(semilla.bancolombiaId) } })).saldo_actual.toString()).toBe('1040000');
      const guardado = await s.prisma.reportesPagoPersona.findFirstOrThrow();
      expect(guardado).toMatchObject({ estado: 'APROBADO', transaccion_id: ingreso.id, cuenta_destino_id: BigInt(semilla.bancolombiaId) });
      expect(guardado.monto_aprobado?.toString()).toBe('40000');

      const l = await liqAndres();
      expect(l.abonosRealizados.subtotal.toString()).toBe('-40000');
      expect(l.resumenNeto.saldoNetoFinal.toString()).toBe('21500'); // 61.500 − 40.000
      // el enlace se refrescó solo: la persona ve su saldo nuevo y que su pago fue aprobado
      const publico: any = await s.cobroPublico.ver(t);
      expect(publico.resumen.saldoNetoFinal).toBe(21500);
      expect(publico.reportes[0]).toMatchObject({ estado: 'APROBADO' });
      expect(Number(publico.reportes[0].montoAprobado)).toBe(40000);
      // no se puede aprobar ni rechazar dos veces
      await expect(s.reportesPago.aprobar(Number(rep.id), {}, semilla.userId)).rejects.toMatchObject({ status: 409 });
      await expect(s.reportesPago.rechazar(Number(rep.id), { motivo: 'x1' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });

    it('APROBAR con otro monto (llegó menos) y sin cuenta: solo se anota el abono', async () => {
      const t = await tokenDe();
      await reportar(t, { monto: 61500 });
      const [rep] = await s.reportesPago.listar(semilla.userId, {});
      await s.reportesPago.aprobar(Number(rep.id), { monto: 50000 }, semilla.userId);
      expect(await s.prisma.transacciones.count()).toBe(0);
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('11500');
      await expect(s.reportesPago.aprobar(Number(rep.id), { monto: 10 }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });

    it('RECHAZAR deja el motivo a la vista de la persona y la deuda intacta', async () => {
      const t = await tokenDe();
      await reportar(t, { monto: 61500 });
      const [rep] = await s.reportesPago.listar(semilla.userId, {});
      const r = await s.reportesPago.rechazar(Number(rep.id), { motivo: 'No veo la transferencia en mi cuenta' }, semilla.userId);
      expect(r).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'No veo la transferencia en mi cuenta' });
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('61500');
      const publico: any = await s.cobroPublico.ver(t);
      expect(publico.reportes[0]).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'No veo la transferencia en mi cuenta' });
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { signo: -1 } })).toBe(0);
    });

    it('el saldo que no se pagó pasa al siguiente cierre como «saldo anterior»', async () => {
      const t = await tokenDe();
      await reportar(t, { monto: 20000 });
      const [rep] = await s.reportesPago.listar(semilla.userId, {});
      await s.reportesPago.aprobar(Number(rep.id), {}, semilla.userId);

      // octubre queda debiendo 41.500; en noviembre aparece como saldo anterior y suma a lo acumulado
      await s.cobrosPuntuales.crear(cobro({ concepto: 'Luz noviembre', fechaGasto: '2026-11-10', montoTotal: 30000, participantes: [{ personaId: semilla.andresId }] }), semilla.userId);
      const nov = await liqAndres(SIGUIENTE);
      expect(nov.saldoAnterior.toString()).toBe('41500');
      expect(nov.resumenNeto.saldoNetoFinal.toString()).toBe('30000');
      expect(nov.saldoTotalAcumulado.toString()).toBe('71500');
    });
  });

  describe('ingresos que ya llegaron por correo', () => {
    const recibida = (extra: Partial<NotificacionItemDto> = {}): NotificacionItemDto =>
      ({
        externalMessageId: '<rec>',
        fecha: new Date().toISOString().slice(0, 10),
        hora: '09:00:00',
        tipo: 'Desconocido',
        metodo: 'Transfiya/Bre-b',
        comercio: '',
        origenRaw: '',
        valor: '61500',
        moneda: 'COP',
        cuerpoExtraido: 'Bancolombia: Felipe, recibiste una transferencia de ANDRES por $61,500.00 en tu cuenta *1234 conectada a la llave @felipe el 15/10/26 a las 09:00.',
        ...extra,
      }) as NotificacionItemDto;

    beforeEach(async () => {
      await s.prisma.personas.update({ where: { id: BigInt(semilla.andresId) }, data: { nombre: 'Andrés Gómez Ruiz' } });
      await s.cobrosPuntuales.crear(cobro(), semilla.userId);
      // el correo dice «ANDRES» (una palabra): no alcanza para reconocerlo; con el apellido sí
    });

    it('el correo de Andrés se reconoce, se sugiere aplicarlo y al aprobar su reporte se ENLAZA sin crear otro ingreso', async () => {
      await s.syncBatch.syncBatch(
        [recibida({ cuerpoExtraido: 'Bancolombia: Felipe, recibiste una transferencia de ANDRES GOMEZ RUIZ por $61,500.00 en tu cuenta *1234 conectada a la llave @felipe el 15/10/26.' })],
        semilla.userId,
      );
      expect(await s.prisma.transacciones.count({ where: { tipo_transaccion: 'INGRESO' } })).toBe(1);
      const nota = await s.prisma.notificacionesCorreo.findFirstOrThrow();
      expect(nota.persona_id).toBe(BigInt(semilla.andresId));

      const sugeridos = await s.reportesPago.ingresosSugeridos(semilla.userId);
      expect(sugeridos).toHaveLength(1);
      expect(sugeridos[0]).toMatchObject({ persona: 'Andrés Gómez Ruiz' });
      expect(sugeridos[0].monto.toString()).toBe('61500');

      // Andrés reporta el mismo pago desde su enlace → el reporte avisa que el dinero ya llegó
      const t = await tokenDe();
      await reportar(t, { monto: 61500 });
      const [rep] = await s.reportesPago.listar(semilla.userId, { estado: 'PENDIENTE' });
      expect(rep.correoCoincidente).toMatchObject({ notificacionId: nota.id, transaccionId: nota.transaccion_generada_id });

      const r = await s.reportesPago.aprobar(Number(rep.id), { transaccionId: Number(nota.transaccion_generada_id) }, semilla.userId);
      expect(r.transaccionId).toBe(nota.transaccion_generada_id);
      expect(await s.prisma.transacciones.count({ where: { tipo_transaccion: 'INGRESO' } })).toBe(1); // no se duplicó
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('0');
      expect(await s.reportesPago.ingresosSugeridos(semilla.userId)).toEqual([]); // ya aplicado
      // el mismo ingreso no puede aplicarse dos veces
      await expect(s.reportesPago.aplicarIngreso({ transaccionId: Number(nota.transaccion_generada_id), personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });

    it('aplicar un ingreso suelto como pago (sin reporte de la persona)', async () => {
      await s.syncBatch.syncBatch(
        [recibida({ cuerpoExtraido: 'Bancolombia: Felipe, recibiste una transferencia de ANDRES GOMEZ RUIZ por $61,500.00 en tu cuenta *1234 conectada a la llave @felipe el 15/10/26.', valor: '61500' })],
        semilla.userId,
      );
      const [sug] = await s.reportesPago.ingresosSugeridos(semilla.userId);
      const r = await s.reportesPago.aplicarIngreso({ transaccionId: Number(sug.transaccionId), personaId: semilla.andresId, periodo: PERIODO, monto: 30000 } as any, semilla.userId);
      expect(r.monto.toString()).toBe('30000');
      expect((await liqAndres()).resumenNeto.saldoNetoFinal.toString()).toBe('31500');
    });

    it('con una transacción que no es ingreso o que no existe, no se aplica', async () => {
      const egreso = await s.transacciones.create(
        { tipoTransaccion: 'EGRESO', cuentaOrigenId: semilla.bancolombiaId, concepto: 'x', montoOriginal: 1000, fechaTransaccion: '2026-10-10T10:00:00-05:00' } as any,
        semilla.userId,
      );
      await expect(s.reportesPago.aplicarIngreso({ transaccionId: Number(egreso.id), personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.reportesPago.aplicarIngreso({ transaccionId: 99999, personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId)).rejects.toMatchObject({ status: 404 });
    });
  });
});
