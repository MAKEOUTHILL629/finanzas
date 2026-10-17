/* eslint-disable @typescript-eslint/no-explicit-any */
import { serializeForJson } from '../../src/common/interceptors/json-serialization.interceptor';
import { MAX_OBJECIONES_ABIERTAS } from '../../src/modules/cobros/objeciones-cobro.service';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Fase 6 del plan V2 contra PostgreSQL real: medios de pago del enlace, observaciones de la persona, su resolución por el
 * propietario (ajustar, excluir, descontar, mantener) con el total recalculado en el enlace, y abonos parciales.
 */
describeDb('Integración BD — enlace de cobro, fase 6', () => {
  let s: Servicios;
  let semilla: Semilla;
  const PERIODO = '2026-10';

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

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF').toString('base64');

  const luz = () =>
    ({
      concepto: 'Recibo de la luz',
      categoria: 'SERVICIO',
      fechaGasto: '2026-10-14',
      montoTotal: 184500,
      modoDivision: 'IGUAL',
      participantes: [{ personaId: semilla.yoId }, { personaId: semilla.andresId }, { personaId: semilla.papaId }],
    }) as any;

  /** Andrés debe $61.500 de la luz; devuelve su enlace y el renglón. */
  async function escenario() {
    await s.cobrosPuntuales.crear(luz(), semilla.userId);
    const enlace = await s.enlacesCobro.generar({ personaId: semilla.andresId, periodo: PERIODO } as any, semilla.userId);
    const publico: any = await s.cobroPublico.ver(enlace.token);
    const item = publico.bloques.find((b: any) => b.clave === 'cobrosPuntuales').items[0];
    return { enlace, token: enlace.token as string, item };
  }
  const saldo = async () => Number((await s.liquidacion.liquidacionPersona(PERIODO, semilla.andresId, semilla.userId)).resumenNeto.saldoNetoFinal);
  const objetarItem = (token: string, clave: string, comentario = 'Este gasto no era mío', extra: Record<string, unknown> = {}) =>
    s.cobroPublico.objetar(token, { alcance: 'ITEM', itemClave: clave, comentario, ...extra } as any);

  async function otroUsuario() {
    const u = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', name: 'Otro', is_active: true } });
    return u.id;
  }

  // ───────────────────────────── medios de pago ─────────────────────────────

  describe('medios de pago', () => {
    const nequi = { tipo: 'NEQUI', entidad: 'Nequi', numero: '300 123 4567', titular: 'Felipe Hernández' } as any;
    const ahorros = { tipo: 'CUENTA_AHORROS', entidad: 'Bancolombia', numero: '123-456789-01', documento: '1.023.456.789', instrucciones: 'Pon tu nombre en la descripción' } as any;

    it('se crean en orden, se validan por tipo y solo los activos llegan al enlace público (sin datos internos)', async () => {
      const a = await s.metodosPago.crear(nequi, semilla.userId);
      const b = await s.metodosPago.crear(ahorros, semilla.userId);
      expect([a.orden, b.orden]).toEqual([0, 1]);
      expect((await s.metodosPago.listar(semilla.userId)).map((m) => m.entidad)).toEqual(['Nequi', 'Bancolombia']);

      await expect(s.metodosPago.crear({ tipo: 'NEQUI', entidad: 'Nequi', numero: '12345' } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.metodosPago.crear({ ...ahorros, cuentaId: 999999 }, semilla.userId)).rejects.toBeDefined();

      const { token } = await escenario();
      let publico: any = await s.cobroPublico.ver(token);
      expect(publico.metodosPago.map((m: any) => m.entidad)).toEqual(['Nequi', 'Bancolombia']);
      expect(publico.metodosPago[1]).toMatchObject({ numero: '123-456789-01', documento: '1.023.456.789', instrucciones: 'Pon tu nombre en la descripción', tieneQr: false });
      const json = JSON.stringify(serializeForJson(publico));
      expect(json).not.toContain('owner_user_id');
      expect(json).not.toContain('cuentaId');

      await s.metodosPago.actualizar(Number(a.id), { activo: false }, semilla.userId);
      publico = await s.cobroPublico.ver(token);
      expect(publico.metodosPago.map((m: any) => m.entidad)).toEqual(['Bancolombia']);
    });

    it('se editan (validando de nuevo), se reordenan, se vinculan a una cuenta propia y se eliminan; los de otro usuario no se tocan', async () => {
      const m = await s.metodosPago.crear({ ...ahorros, cuentaId: semilla.bancolombiaId }, semilla.userId);
      expect(m.cuentaId).toBe(BigInt(semilla.bancolombiaId));

      const e = await s.metodosPago.actualizar(Number(m.id), { numero: '999888777', titular: 'Felipe', documento: null, orden: 5 }, semilla.userId);
      expect(e).toMatchObject({ numero: '999888777', titular: 'Felipe', documento: null, orden: 5 });
      await expect(s.metodosPago.actualizar(Number(m.id), { tipo: 'NEQUI' }, semilla.userId)).rejects.toMatchObject({ status: 400 }); // 999888777 no es un celular
      await expect(s.metodosPago.actualizar(Number(m.id), { cuentaId: 424242 }, semilla.userId)).rejects.toBeDefined();
      await expect(s.metodosPago.actualizar(424242, { activo: false }, semilla.userId)).rejects.toMatchObject({ status: 404 });

      const otro = await otroUsuario();
      expect(await s.metodosPago.listar(otro)).toEqual([]);
      await expect(s.metodosPago.actualizar(Number(m.id), { activo: false }, otro)).rejects.toMatchObject({ status: 404 });
      await expect(s.metodosPago.eliminar(Number(m.id), otro)).rejects.toMatchObject({ status: 404 });

      expect(await s.metodosPago.eliminar(Number(m.id), semilla.userId)).toEqual({ eliminado: true });
      expect(await s.metodosPago.listar(semilla.userId)).toEqual([]);
    });

    it('el QR es una imagen pequeña con firma válida; el enlace solo lo sirve si el medio está activo', async () => {
      const m = await s.metodosPago.crear(nequi, semilla.userId);
      const { token } = await escenario();

      await expect(s.metodosPago.guardarQr(Number(m.id), { qr: { nombre: 'qr.pdf', tipo: 'application/pdf', datos: PDF } } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.metodosPago.guardarQr(Number(m.id), { qr: { nombre: 'qr.png', tipo: 'image/png', datos: PDF } } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      const grande = Buffer.concat([Buffer.from(PNG, 'base64').subarray(0, 8), Buffer.alloc(450_000)]).toString('base64');
      await expect(s.metodosPago.guardarQr(Number(m.id), { qr: { nombre: 'qr.png', tipo: 'image/png', datos: grande } } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });

      const conQr = await s.metodosPago.guardarQr(Number(m.id), { qr: { nombre: 'qr.png', tipo: 'image/png', datos: PNG } } as any, semilla.userId);
      expect(conQr.tieneQr).toBe(true);
      expect((await s.metodosPago.qr(Number(m.id), semilla.userId)).tipo).toBe('image/png');
      const publico: any = await s.cobroPublico.ver(token);
      expect(publico.metodosPago[0].tieneQr).toBe(true);
      expect(JSON.stringify(serializeForJson(publico))).not.toContain(PNG);
      const servido = await s.cobroPublico.qrMetodo(token, Number(m.id));
      expect(servido.tipo).toBe('image/png');
      expect(servido.datos.length).toBeGreaterThan(20);

      await s.metodosPago.actualizar(Number(m.id), { activo: false }, semilla.userId);
      await expect(s.cobroPublico.qrMetodo(token, Number(m.id))).rejects.toMatchObject({ status: 404 });
      await s.metodosPago.actualizar(Number(m.id), { activo: true }, semilla.userId);
      expect((await s.metodosPago.quitarQr(Number(m.id), semilla.userId)).tieneQr).toBe(false);
      await expect(s.cobroPublico.qrMetodo(token, Number(m.id))).rejects.toMatchObject({ status: 404 });
    });
  });

  // ───────────────────────────── observaciones ─────────────────────────────

  describe('observaciones de la persona', () => {
    it('cada renglón del enlace trae su clave y la observación guarda lo que la persona vio', async () => {
      const { token, item } = await escenario();
      expect(item.clave).toMatch(/^[0-9a-f]{16}$/);
      const o: any = await objetarItem(token, item.clave, 'Ya te había abonado $50.000 de esto', { montoPropuesto: '11500' });
      expect(o).toMatchObject({ alcance: 'ITEM', concepto: 'Recibo de la luz', estado: 'ABIERTA', comentario: 'Ya te había abonado $50.000 de esto' });
      expect(Number(o.monto)).toBe(61500);
      expect(Number(o.montoPropuesto)).toBe(11500);

      const publico: any = await s.cobroPublico.ver(token);
      expect(publico.objeciones).toHaveLength(1);
      expect(publico.objeciones[0]).toMatchObject({ estado: 'ABIERTA', resolucion: null, respuesta: null });

      const admin = await s.objeciones.listar(semilla.userId, { estado: 'ABIERTA' });
      expect(admin).toHaveLength(1);
      expect(admin[0]).toMatchObject({ persona: 'Andrés', periodo: PERIODO, concepto: 'Recibo de la luz', alcance: 'ITEM' });
      expect((await s.enlacesCobro.listar(semilla.userId))[0].objecionesAbiertas).toBe(1);
    });

    it('el comentario es obligatorio, el renglón debe existir y se puede observar el total', async () => {
      const { token, item } = await escenario();
      await expect(objetarItem(token, item.clave, '  a ')).rejects.toMatchObject({ status: 400 });
      await expect(objetarItem(token, 'no-existe')).rejects.toMatchObject({ status: 400 });
      await expect(s.cobroPublico.objetar(token, { alcance: 'ITEM', comentario: 'sin renglón' } as any)).rejects.toMatchObject({ status: 400 });
      expect(await s.prisma.objecionesCobro.count()).toBe(0);

      const total: any = await s.cobroPublico.objetar(token, { alcance: 'TOTAL', comentario: 'No reconozco este total' } as any);
      expect(total).toMatchObject({ alcance: 'TOTAL', concepto: null, monto: null });
      await expect(s.cobroPublico.objetar('token-que-no-existe-0000000000', { alcance: 'TOTAL', comentario: 'hola' } as any)).rejects.toMatchObject({ status: 404 });
    });

    it('un enlace revocado no recibe observaciones y hay un tope de observaciones abiertas', async () => {
      const { enlace, token, item } = await escenario();
      const fila = await s.prisma.enlacesCobroPersona.findFirstOrThrow({ where: { id: BigInt(enlace.id) } });
      for (let i = 0; i < MAX_OBJECIONES_ABIERTAS; i += 1) await s.objeciones.crear(fila, { alcance: 'TOTAL', comentario: `Observación ${i}` } as any);
      await expect(objetarItem(token, item.clave)).rejects.toMatchObject({ status: 409 });
      await s.enlacesCobro.revocar(Number(enlace.id), semilla.userId);
      await expect(objetarItem(token, item.clave)).rejects.toMatchObject({ status: 404 });
    });
  });

  // ───────────────────────────── resolver ─────────────────────────────

  describe('resolver una observación', () => {
    it('AJUSTAR baja el cobro: asiento de descuento, saldo menor y el enlace de la persona recalculado', async () => {
      const { token, item } = await escenario();
      expect(await saldo()).toBe(61500);
      const o: any = await objetarItem(token, item.clave, 'Solo usé la mitad del mes');

      const r = await s.objeciones.resolver(Number(o.id), { accion: 'AJUSTAR', monto: 40000, respuesta: 'Tienes razón, lo ajusto' }, semilla.userId);
      expect(r.descuento!.toString()).toBe('21500');
      expect(r.objecion).toMatchObject({ estado: 'RESUELTA', resolucion: 'AJUSTADA', respuesta: 'Tienes razón, lo ajusto' });
      expect(Number(r.objecion.montoAjuste)).toBe(21500);

      const mov = await s.prisma.movimientosDeudaPersona.findMany({ where: { tipo_movimiento: 'AJUSTE_DESCUENTO' } });
      expect(mov).toHaveLength(1);
      expect(mov[0]).toMatchObject({ signo: -1, estado: 'CONFIRMADO', periodo_imputacion: PERIODO, persona_id: BigInt(semilla.andresId) });
      expect(mov[0].monto.toString()).toBe('21500');
      expect(mov[0].concepto).toBe('Ajuste de «Recibo de la luz»: de $61,500.00 a $40,000.00');
      expect(r.objecion.movimientoId).toBe(mov[0].id);

      expect(await saldo()).toBe(40000);
      const liq = await s.liquidacion.liquidacionPersona(PERIODO, semilla.andresId, semilla.userId);
      expect(liq.abonosRealizados.items.map((i) => [i.origen, i.concepto])).toEqual([['DESCUENTO', 'Ajuste de «Recibo de la luz»: de $61,500.00 a $40,000.00']]);

      // lo que ve la persona
      expect(r.enlace.resumen!.saldoNetoFinal).toBe(40000);
      const publico: any = await s.cobroPublico.ver(token);
      expect(publico.resumen.saldoNetoFinal).toBe(40000);
      expect(publico.objeciones[0]).toMatchObject({ estado: 'RESUELTA', resolucion: 'AJUSTADA', respuesta: 'Tienes razón, lo ajusto' });
      expect(Number(publico.objeciones[0].montoAjuste)).toBe(21500);
      expect((await s.enlacesCobro.listar(semilla.userId))[0].objecionesAbiertas).toBe(0);

      await expect(s.objeciones.resolver(Number(o.id), { accion: 'MANTENER', respuesta: 'otra vez' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });

    it('EXCLUIR quita el cobro completo y el saldo queda en paz y salvo', async () => {
      const { token, item } = await escenario();
      const o: any = await objetarItem(token, item.clave);
      const r = await s.objeciones.resolver(Number(o.id), { accion: 'EXCLUIR' }, semilla.userId);
      expect(r.descuento!.toString()).toBe('61500');
      expect(r.objecion.resolucion).toBe('EXCLUIDA');
      expect(await saldo()).toBe(0);
      expect(r.enlace.resumen!.estado).toBe('PAZ_Y_SALVO');
    });

    it('MANTENER exige explicarle a la persona por qué y no cambia el saldo', async () => {
      const { token, item } = await escenario();
      const o: any = await objetarItem(token, item.clave);
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'MANTENER' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'MANTENER', respuesta: ' ' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      const r = await s.objeciones.resolver(Number(o.id), { accion: 'MANTENER', respuesta: 'Está en el recibo que te mandé' }, semilla.userId);
      expect(r.descuento).toBeNull();
      expect(r.objecion).toMatchObject({ resolucion: 'MANTENIDA', respuesta: 'Está en el recibo que te mandé', movimientoId: null });
      expect(await saldo()).toBe(61500);
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { tipo_movimiento: 'AJUSTE_DESCUENTO' } })).toBe(0);
      const publico: any = await s.cobroPublico.ver(token);
      expect(publico.objeciones[0].respuesta).toBe('Está en el recibo que te mandé');
    });

    it('una observación sobre el total solo se resuelve con descuento o manteniéndola; el descuento no pasa de lo que debe', async () => {
      const { token } = await escenario();
      const o: any = await s.cobroPublico.objetar(token, { alcance: 'TOTAL', comentario: 'Creo que debo menos' } as any);
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'AJUSTAR', monto: 1000 }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'EXCLUIR' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'DESCUENTO', monto: 70000 }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'DESCUENTO' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      expect((await s.prisma.objecionesCobro.findFirstOrThrow()).estado).toBe('ABIERTA'); // nada quedó a medias

      const r = await s.objeciones.resolver(Number(o.id), { accion: 'DESCUENTO', monto: 11500, respuesta: 'Te descuento lo que ya habías pagado' }, semilla.userId);
      expect(r.objecion.resolucion).toBe('DESCUENTO');
      expect(await saldo()).toBe(50000);
    });

    it('un abono no se puede ajustar (solo los cobros)', async () => {
      const { enlace } = await escenario();
      const t = enlace.token as string;
      const rep: any = await s.cobroPublico.reportar(t, { monto: 20000, fechaPago: new Date().toISOString().slice(0, 10) } as any);
      await s.reportesPago.aprobar(Number(rep.id), {} as any, semilla.userId);
      const publico: any = await s.cobroPublico.ver(t);
      const abono = publico.bloques.find((b: any) => b.clave === 'abonosRealizados').items[0];
      expect(abono.impacto).toBeLessThan(0);
      const o: any = await objetarItem(t, abono.clave, 'No me registraron bien este pago');
      expect(Number(o.monto)).toBe(-20000);
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'AJUSTAR', monto: 1 }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'EXCLUIR' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
    });

    it('el propietario de otro usuario no ve ni resuelve estas observaciones', async () => {
      const { token, item } = await escenario();
      const o: any = await objetarItem(token, item.clave);
      const otro = await otroUsuario();
      expect(await s.objeciones.listar(otro)).toEqual([]);
      await expect(s.objeciones.resolver(Number(o.id), { accion: 'EXCLUIR' }, otro)).rejects.toMatchObject({ status: 404 });
    });
  });

  // ───────────────────────────── descuentos directos ─────────────────────────────

  describe('descuento directo y reversa', () => {
    it('baja el saldo sin que haya observación, se lista y se puede deshacer', async () => {
      const { enlace, token } = await escenario();
      const id = Number(enlace.id);
      const d = await s.objeciones.descuentoDirecto(id, { monto: 11500, motivo: 'Ya me había abonado' } as any, semilla.userId);
      expect(d.descuento.toString()).toBe('11500');
      expect(d.enlace.resumen!.saldoNetoFinal).toBe(50000);
      expect(await saldo()).toBe(50000);

      const lista = await s.objeciones.ajustes(id, semilla.userId);
      expect(lista).toHaveLength(1);
      expect(lista[0]).toMatchObject({ concepto: 'Descuento del propietario: Ya me había abonado', objecionId: null });
      expect(Number(lista[0].monto)).toBe(11500);

      await s.objeciones.deshacerAjuste(Number(lista[0].movimientoId), semilla.userId);
      expect(await saldo()).toBe(61500);
      expect(await s.objeciones.ajustes(id, semilla.userId)).toEqual([]);
      expect(((await s.cobroPublico.ver(token)) as any).resumen.saldoNetoFinal).toBe(61500);
      await expect(s.objeciones.deshacerAjuste(Number(lista[0].movimientoId), semilla.userId)).rejects.toMatchObject({ status: 404 });
    });

    it('no pasa de lo que debe ni se aplica a quien no debe nada', async () => {
      const { enlace } = await escenario();
      const id = Number(enlace.id);
      await expect(s.objeciones.descuentoDirecto(id, { monto: 61500.01, motivo: 'demasiado' } as any, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await s.objeciones.descuentoDirecto(id, { monto: 61500, motivo: 'Todo perdonado' } as any, semilla.userId);
      expect(await saldo()).toBe(0);
      await expect(s.objeciones.descuentoDirecto(id, { monto: 1, motivo: 'otro más' } as any, semilla.userId)).rejects.toMatchObject({ status: 409 });
      const otro = await otroUsuario();
      await expect(s.objeciones.descuentoDirecto(id, { monto: 1, motivo: 'ajeno' } as any, otro)).rejects.toMatchObject({ status: 404 });
    });

    it('deshacer un ajuste que resolvía una observación la deja abierta otra vez', async () => {
      const { token, item } = await escenario();
      const o: any = await objetarItem(token, item.clave);
      const r = await s.objeciones.resolver(Number(o.id), { accion: 'EXCLUIR', respuesta: 'Lo quito' }, semilla.userId);
      expect(await saldo()).toBe(0);
      await s.objeciones.deshacerAjuste(Number(r.objecion.movimientoId), semilla.userId);
      expect(await saldo()).toBe(61500);
      const reabierta = await s.prisma.objecionesCobro.findUniqueOrThrow({ where: { id: BigInt(o.id) } });
      expect(reabierta).toMatchObject({ estado: 'ABIERTA', resolucion: null, respuesta: null, movimiento_id: null, monto_ajuste: null });
      expect((await s.enlacesCobro.listar(semilla.userId))[0].objecionesAbiertas).toBe(1);
      const mov = await s.prisma.movimientosDeudaPersona.findFirstOrThrow({ where: { tipo_movimiento: 'AJUSTE_DESCUENTO' } });
      expect(mov.estado).toBe('ANULADO'); // el asiento queda trazado, no se borra
    });
  });

  // ───────────────────────────── abono parcial y rechazo ─────────────────────────────

  describe('abonos parciales y rechazo de comprobantes', () => {
    const hoy = () => new Date().toISOString().slice(0, 10);

    it('un aviso por menos de lo que debe se marca como abono parcial y dice cuánto queda', async () => {
      const { token } = await escenario();
      const parcial: any = await s.cobroPublico.reportar(token, { monto: 20000, fechaPago: hoy(), medio: 'BREB' } as any);
      expect(parcial.parcial).toBe(true);
      expect(Number(parcial.saldoRestante)).toBe(41500);
      expect(parcial.mensaje).toContain('abono');
      const completo: any = await s.cobroPublico.reportar(token, { monto: 61500, fechaPago: hoy() } as any);
      expect(completo).toMatchObject({ parcial: false, saldoRestante: null });
      const vistos: any = await s.cobroPublico.ver(token); // la persona también ve cuál de sus avisos fue parcial
      expect(vistos.reportes.map((r: any) => [Number(r.id), r.parcial]).sort()).toEqual([[Number(parcial.id), true], [Number(completo.id), false]].sort());

      const lista: any[] = await s.reportesPago.listar(semilla.userId);
      const p = lista.find((r) => Number(r.id) === Number(parcial.id));
      expect(p).toMatchObject({ esParcial: true });
      expect(Number(p.saldoAlReportar)).toBe(61500);
      expect(Number(p.pendienteTrasPago)).toBe(41500);
      expect(lista.find((r) => Number(r.id) === Number(completo.id))).toMatchObject({ esParcial: false, pendienteTrasPago: null });
    });

    it('aprobar un abono parcial deja el resto por cobrar y el enlace lo refleja', async () => {
      const { token } = await escenario();
      const rep: any = await s.cobroPublico.reportar(token, { monto: 20000, fechaPago: hoy() } as any);
      await s.reportesPago.aprobar(Number(rep.id), {} as any, semilla.userId);
      expect(await saldo()).toBe(41500);
      expect(((await s.cobroPublico.ver(token)) as any).resumen.saldoNetoFinal).toBe(41500);
    });

    it('el rechazo del propietario deja su comentario visible en el enlace y la deuda igual', async () => {
      const { token } = await escenario();
      const rep: any = await s.cobroPublico.reportar(token, { monto: 61500, fechaPago: hoy() } as any);
      await s.reportesPago.rechazar(Number(rep.id), { motivo: 'El comprobante no corresponde al monto acordado' }, semilla.userId);
      const publico: any = await s.cobroPublico.ver(token);
      expect(publico.reportes[0]).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'El comprobante no corresponde al monto acordado' });
      expect(await saldo()).toBe(61500);
      await expect(s.reportesPago.rechazar(Number(rep.id), { motivo: 'otra vez' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
    });
  });
});
