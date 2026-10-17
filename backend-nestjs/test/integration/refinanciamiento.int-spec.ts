/* eslint-disable @typescript-eslint/no-explicit-any */
import { hoyBogota, periodoOf } from '../../src/common/utils/date.util';
import { CompraCreditoInput } from '../../src/modules/compras-credito/dto/compra-credito.dto';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/**
 * Refinanciamiento / unificación de deuda (plan V2, fase 5) en PostgreSQL real: la simulación, la ejecución atómica con su
 * trazabilidad, las personas responsables, el sub-ledger, las sumas de deuda y deshacerlo.
 */
describeDb('Integración BD — refinanciamiento de la deuda de una tarjeta', () => {
  let s: Servicios;
  let semilla: Semilla;

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

  const hoy = () => hoyBogota();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const nueva = (extra: Partial<CompraCreditoInput> = {}): CompraCreditoInput => ({
    concepto: 'Nevera',
    valorCompra: 1_200_000,
    fechaCompra: iso(hoy()),
    numeroCuotas: 12,
    interes: 0,
    descripcion: 'Éxito',
    estado: 'Pendiente',
    tarjeta: semilla.tarjetaId,
    ...extra,
  });
  const crear = (extra: Partial<CompraCreditoInput> = {}) => s.compras.save(nueva(extra), semilla.userId);
  const responsable = (compra: number, persona: number, pct: number, cuotas = 12, valor = 1_200_000) =>
    s.responsables.create({ persona, porcentajePago: pct, cantidadPago: (valor * pct) / 100, cantidadCuotas: cuotas, compraCredito: compra } as any, semilla.userId);
  const dto = (compraIds: number[], extra: Record<string, unknown> = {}) => ({ tarjetaId: semilla.tarjetaId, compraIds, numeroCuotas: 24, tasaMensual: '1.5', ...extra }) as any;
  const unificar = (compraIds: number[], extra: Record<string, unknown> = {}) => s.refinanciamientos.ejecutar(semilla.userId, dto(compraIds, extra));
  const compraDb = (id: number | bigint) => s.prisma.comprasCredito.findUniqueOrThrow({ where: { id: BigInt(id) } });
  const cuotasDb = (id: number | bigint) => s.prisma.cuotasDetalle.findMany({ where: { compra: BigInt(id) }, orderBy: { numero_cuota: 'asc' } });

  /** Dos compras: A (1,2 M a 12 cuotas, 100 % de Andrés) y B (600 mil a 6 cuotas al 2 %, 50 % de Papá). */
  async function escenario() {
    const a = await crear({ concepto: 'Nevera', valorCompra: 1_200_000, numeroCuotas: 12 });
    await responsable(a, semilla.andresId, 100);
    const b = await crear({ concepto: 'Televisor', valorCompra: 600_000, numeroCuotas: 6, interes: 2 });
    await responsable(b, semilla.papaId, 50, 6, 600_000);
    return { a, b };
  }

  describe('candidatas', () => {
    it('lista las compras pendientes de la tarjeta con su saldo de capital, la próxima cuota y sus responsables', async () => {
      const { a, b } = await escenario();
      const lista = await s.refinanciamientos.candidatas(semilla.userId, semilla.tarjetaId);
      expect(lista.map((c) => c.id).sort()).toEqual([a, b].sort());
      const ca = lista.find((c) => c.id === a)!;
      expect(ca).toMatchObject({ concepto: 'Nevera', saldoCapital: 1_200_000, cuotasPendientes: 12, cuotaProxima: 100_000, esRefinanciamiento: false });
      expect(ca.responsables).toEqual([{ personaId: semilla.andresId, porcentaje: 100 }]);
      const cb = lista.find((c) => c.id === b)!;
      expect(cb).toMatchObject({ saldoCapital: 600_000, cuotasPendientes: 6 });
      expect(cb.restantePorPagar).toBeGreaterThan(600_000); // incluye los intereses de las cuotas
    });

    it('no ofrece las pagadas, las de otra tarjeta, las ya unificadas ni las de una tarjeta de débito', async () => {
      const { a } = await escenario();
      await crear({ concepto: 'Ya paga', estado: 'Pagado' });
      const otra = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Master' } });
      await crear({ concepto: 'En otra tarjeta', tarjeta: Number(otra.id) });
      await s.prisma.comprasCredito.update({ where: { id: BigInt(a) }, data: { estado: 'REFINANCIADA' } });
      const lista = await s.refinanciamientos.candidatas(semilla.userId, semilla.tarjetaId);
      expect(lista.map((c) => c.concepto)).toEqual(['Televisor']);

      const debito = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Débito', tipo_tarjeta: 'DEBITO', cuenta_id: BigInt(semilla.bancolombiaId) } });
      await expect(s.refinanciamientos.candidatas(semilla.userId, Number(debito.id))).rejects.toMatchObject({ status: 400 });
      await expect(s.refinanciamientos.candidatas(semilla.userId, 9999)).rejects.toMatchObject({ status: 404 });
    });

    it('solo cuentan las cuotas del periodo en curso en adelante (las viejas sin marcar pagadas no son saldo)', async () => {
      const a = await crear({ concepto: 'Vieja', fechaCompra: '2024-01-10', numeroCuotas: 12 }); // todas sus cuotas están en el pasado
      const lista = await s.refinanciamientos.candidatas(semilla.userId, semilla.tarjetaId);
      expect(lista.find((c) => c.id === a)).toBeUndefined();
    });
  });

  describe('simular', () => {
    it('calcula con lo de las compras elegidas y NO escribe nada', async () => {
      const { a, b } = await escenario();
      const antes = await s.prisma.comprasCredito.count();
      const sim = await s.refinanciamientos.simular(semilla.userId, dto([a, b]));
      expect(sim.resultado.saldo.toNumber()).toBe(1_800_000);
      expect(sim.cuotaActualCombinada).toBe(200_000); // 1.ª cuota de A (100.000) + 1.ª de B (100.000: la primera cuota no cobra interés)
      expect(sim.resultado.numeroCuotas).toBe(24);
      expect(sim.resultado.cuotas).toHaveLength(24);
      expect(sim.resultado.cuotaCalculada?.toNumber()).toBeGreaterThan(80_000);
      expect(sim.compraIds.sort()).toEqual([a, b].sort());
      // Andrés conserva su parte del saldo (1,2 M de 1,8 M = 66,67 %) y Papá la suya (la mitad de 600 mil = 16,67 %)
      expect(sim.responsables.map((r) => [r.personaId, r.porcentaje.toNumber()])).toEqual([[semilla.andresId, 66.67], [semilla.papaId, 16.67]]);
      expect(await s.prisma.comprasCredito.count()).toBe(antes);
    });

    it('rechaza compras que no se pueden unificar, nombrándolas', async () => {
      const { a } = await escenario();
      const pagada = await crear({ concepto: 'Pagada', estado: 'Pagado' });
      await expect(s.refinanciamientos.simular(semilla.userId, dto([a, pagada, 999999]))).rejects.toMatchObject({
        status: 400,
        response: { errors: { compraIds: [expect.stringContaining(`${pagada}, 999999`)] } },
      });
    });

    it('la cuota que da el banco manda sobre la calculada (con la tasa real que implica); una que no alcanza se rechaza', async () => {
      const { a } = await escenario();
      const sim = await s.refinanciamientos.simular(semilla.userId, dto([a], { cuotaMensual: '70000' }));
      expect(sim.resultado.cuotaPactada?.toNumber()).toBe(70_000);
      expect(sim.resultado.cuotas[0].pagoTotal.toNumber()).toBe(70_000);
      expect(sim.resultado.cuotas).toHaveLength(24); // sin terminar antes: la tasa se ajusta a esa cuota
      expect(sim.resultado.tasaMensualPct.toNumber()).toBeGreaterThan(1.5);
      await expect(s.refinanciamientos.simular(semilla.userId, dto([a], { cuotaMensual: '1000' }))).rejects.toMatchObject({ status: 400 });
    });

    it('solo con la cuota del banco (sin tasa) también se simula', async () => {
      const { a } = await escenario();
      const sim = await s.refinanciamientos.simular(semilla.userId, dto([a], { tasaMensual: undefined, cuotaMensual: '62000' }));
      expect(sim.resultado.tasaInformadaPct).toBeNull();
      expect(sim.resultado.tasaMensualPct.toNumber()).toBeGreaterThan(1.5);
    });
  });

  describe('ejecutar', () => {
    it('crea la obligación nueva con cuota fija, marca las originales y las deja vinculadas', async () => {
      const { a, b } = await escenario();
      const r = await unificar([a, b]);

      const maestra = await compraDb(r.id);
      expect(maestra).toMatchObject({ es_refinanciamiento: true, sistema_amortizacion: 'FRANCES', estado: 'Pendiente', numero_cuotas: 24, tarjeta: BigInt(semilla.tarjetaId), owner_user_id: semilla.userId });
      expect(maestra.valor_compra?.toString()).toBe('1800000');
      expect(maestra.interes?.toString()).toBe('1.5');
      expect(maestra.concepto).toContain('Refinanciamiento');
      expect(maestra.refinanciamiento_id).toBeNull();
      const cuotas = await cuotasDb(r.id);
      expect(cuotas).toHaveLength(24);
      expect(cuotas.every((c) => c.estado === 'Pendiente')).toBe(true);
      expect(cuotas[0].pago_total?.toString()).toBe(cuotas[10].pago_total?.toString()); // cuota fija
      expect(cuotas[23].saldo_restante?.toString()).toBe('0');
      expect(maestra.pago_mensual?.toString()).toBe(cuotas[0].pago_total?.toString());

      for (const [id, saldo] of [[a, '1200000'], [b, '600000']] as const) {
        const original = await compraDb(id);
        expect(original).toMatchObject({ estado: 'REFINANCIADA', refinanciamiento_id: maestra.id });
        expect(original.saldo_refinanciado?.toString()).toBe(saldo);
        const c = await cuotasDb(id);
        expect(c.every((x) => x.estado === 'REFINANCIADA')).toBe(true); // todas estaban por pagar
      }
      expect(r.simulacion.resultado.numeroCuotas).toBe(24);
    });

    it('la obligación nueva hereda a las personas responsables en proporción al capital y sus cargos pasan a la nueva', async () => {
      const { a, b } = await escenario();
      const r = await unificar([a, b]);
      const resp = await s.prisma.responsablesComprasCredito.findMany({ where: { compra_credito: BigInt(r.id) }, orderBy: { id: 'asc' } });
      expect(resp.map((x) => [Number(x.persona), x.porcentaje_pago?.toString(), x.cantidad_cuotas])).toEqual([
        [semilla.andresId, '66.67', 24],
        [semilla.papaId, '16.67', 24],
      ]);
      expect(resp[0].cantidad_pago?.toString()).toBe('1200060'); // 66,67 % de 1,8 M

      // sub-ledger: los cargos de las originales quedan anulados y la nueva genera los suyos (Trigger 6)
      const viejos = await s.prisma.movimientosDeudaPersona.findMany({ where: { cuota_detalle: { compra: { in: [BigInt(a), BigInt(b)] } } } });
      expect(viejos.length).toBeGreaterThan(0);
      expect(viejos.every((m) => m.estado === 'ANULADO')).toBe(true);
      const nuevos = await s.prisma.movimientosDeudaPersona.findMany({ where: { cuota_detalle: { compra: BigInt(r.id) } } });
      expect(nuevos).toHaveLength(48); // 24 cuotas × 2 personas
      expect(nuevos.every((m) => m.estado !== 'ANULADO')).toBe(true);
    });

    it('la deuda no se duplica: lo que cobra el banco y lo que debe cada persona sale solo de la obligación nueva', async () => {
      const { a, b } = await escenario();
      const antes = await s.cuotasTerceros.listar(semilla.userId);
      expect(antes.length).toBeGreaterThan(0);
      const r = await unificar([a, b]);

      const pagos = await s.pagosTarjeta.calcularPagoTarjetasCredito(semilla.userId);
      const total = pagos.reduce((acc, p) => acc + p.valorPago, 0);
      const maestraTotal = (await cuotasDb(r.id)).reduce((acc, c) => acc + Number(c.pago_total), 0);
      expect(total).toBeCloseTo(maestraTotal, 2);

      const terceros = await s.cuotasTerceros.listar(semilla.userId);
      expect(new Set(terceros.map((t) => Number(t.compraId)))).toEqual(new Set([r.id])); // ninguna cuota de las originales
      expect(terceros.length).toBe(48);
    });

    it('nada queda a medias si algo falla (una compra inválida revierte todo)', async () => {
      const { a } = await escenario();
      const antes = await s.prisma.comprasCredito.count();
      await expect(unificar([a, 987654])).rejects.toMatchObject({ status: 400 });
      await expect(unificar([a], { cuotaMensual: '500' })).rejects.toMatchObject({ status: 400 });
      expect(await s.prisma.comprasCredito.count()).toBe(antes);
      expect((await compraDb(a)).estado).toBe('Pendiente');
      expect((await cuotasDb(a)).every((c) => c.estado === 'Pendiente')).toBe(true);
    });

    it('se puede unificar un subconjunto y volver a refinanciar una obligación ya unificada', async () => {
      const { a, b } = await escenario();
      const r1 = await unificar([a], { numeroCuotas: 12, tasaMensual: '1' });
      expect((await compraDb(b)).estado).toBe('Pendiente'); // B sigue como estaba
      const candidatas = await s.refinanciamientos.candidatas(semilla.userId, semilla.tarjetaId);
      expect(candidatas.map((c) => [c.id, c.esRefinanciamiento]).sort()).toEqual([[b, false], [r1.id, true]].sort());
      const r2 = await unificar([r1.id, b], { numeroCuotas: 36, tasaMensual: undefined, tasaEfectivaAnual: '20' });
      expect((await compraDb(r1.id)).refinanciamiento_id).toBe(BigInt(r2.id));
      expect((await compraDb(r2.id)).interes?.toString()).toBe('1.5309');
      const d = await s.refinanciamientos.detalle(semilla.userId, r2.id);
      expect(d.absorbidas.map((x) => [x.id, x.esRefinanciamiento]).sort()).toEqual([[b, false], [r1.id, true]].sort());
    });

    it('con la cuota exacta del banco guarda cuota_fija_pactada y la tasa real, y la tabla la respeta (también al recalcular)', async () => {
      const { a } = await escenario();
      const r = await unificar([a], { cuotaMensual: '62000' });
      const maestra = await compraDb(r.id);
      expect(maestra.cuota_fija_pactada?.toString()).toBe('62000');
      expect(maestra.pago_mensual?.toString()).toBe('62000');
      expect(Number(maestra.interes)).toBeGreaterThan(1.5); // la tasa que esa cuota implica
      const cuotas = await cuotasDb(r.id);
      expect(cuotas).toHaveLength(24);
      expect(cuotas[0].pago_total?.toString()).toBe('62000');
      expect(cuotas[23].saldo_restante?.toString()).toBe('0');
      await s.compras.recalcularCuotas(r.id, semilla.userId);
      expect((await cuotasDb(r.id)).map((c) => c.pago_total?.toString())).toEqual(cuotas.map((c) => c.pago_total?.toString()));
    });
  });

  describe('detalle y trazabilidad', () => {
    it('desde la compra nueva o desde una original se llega al mismo refinanciamiento con todo lo que unificó', async () => {
      const { a, b } = await escenario();
      const r = await unificar([a, b]);
      const desdeMaestra = await s.refinanciamientos.detalle(semilla.userId, r.id);
      const desdeOriginal = await s.refinanciamientos.detalle(semilla.userId, a);
      expect(desdeMaestra).toMatchObject({ id: r.id, esMaestra: true, maestraId: r.id, saldoUnificado: 1_800_000, numeroCuotas: 24, tasaMensual: 1.5, sistemaAmortizacion: 'FRANCES' });
      expect(desdeMaestra.absorbidas.map((x) => [x.concepto, x.saldoRefinanciado])).toEqual([['Nevera', 1_200_000], ['Televisor', 600_000]].sort());
      expect(desdeOriginal).toMatchObject({ id: r.id, esMaestra: false, maestraId: r.id });
      expect(desdeOriginal.absorbidas).toEqual(desdeMaestra.absorbidas);
      await expect(s.refinanciamientos.detalle(semilla.userId, await crear({ concepto: 'Otra' }))).rejects.toMatchObject({ status: 404 });
    });

    it('la lista de compras expone el vínculo (refinanciamientoId, esRefinanciamiento, saldoRefinanciado…)', async () => {
      const { a } = await escenario();
      const r = await unificar([a]);
      const lista = await s.compras.list(semilla.userId);
      expect(lista.find((c) => c.id === a)).toMatchObject({ estado: 'REFINANCIADA', refinanciamientoId: r.id, esRefinanciamiento: false, saldoRefinanciado: 1_200_000, sistemaAmortizacion: 'CAPITAL_FIJO' });
      expect(lista.find((c) => c.id === r.id)).toMatchObject({ refinanciamientoId: null, esRefinanciamiento: true, sistemaAmortizacion: 'FRANCES' });
    });
  });

  describe('protecciones', () => {
    it('una compra unificada no se puede modificar, recalcular ni borrar; la obligación nueva no se borra mientras unifique algo', async () => {
      const { a, b } = await escenario();
      const r = await unificar([a, b]);
      const cuerpo = nueva({ valorCompra: 1_000_000 });
      await expect(s.compras.updateCompra(a, cuerpo, semilla.userId)).rejects.toMatchObject({ status: 409 });
      await expect(s.compras.recalcularCuotas(a, semilla.userId)).rejects.toMatchObject({ status: 409 });
      await expect(s.compras.delete(a, semilla.userId)).rejects.toMatchObject({ status: 409 });
      await expect(s.compras.delete(r.id, semilla.userId)).rejects.toMatchObject({ status: 409 });
      expect((await compraDb(a)).estado).toBe('REFINANCIADA');
    });

    it('recalcular la obligación nueva conserva su tabla francesa y su cuota', async () => {
      const { a } = await escenario();
      const r = await unificar([a]);
      const antes = (await cuotasDb(r.id)).map((c) => c.pago_total?.toString());
      await s.compras.recalcularCuotas(r.id, semilla.userId);
      expect((await cuotasDb(r.id)).map((c) => c.pago_total?.toString())).toEqual(antes);
    });
  });

  describe('deshacer', () => {
    it('devuelve todo a como estaba: originales pendientes, sus cargos a las personas y sin la obligación nueva', async () => {
      const { a, b } = await escenario();
      const cargosAntes = await s.prisma.movimientosDeudaPersona.findMany({ where: { cuota_detalle: { compra: { in: [BigInt(a), BigInt(b)] } } }, orderBy: { id: 'asc' } });
      const r = await unificar([a, b]);
      const res = await s.refinanciamientos.deshacer(semilla.userId, r.id);
      expect(res.restauradas).toBe(2);

      expect(await s.prisma.comprasCredito.findUnique({ where: { id: BigInt(r.id) } })).toBeNull();
      expect(await s.prisma.cuotasDetalle.count({ where: { compra: BigInt(r.id) } })).toBe(0);
      for (const id of [a, b]) {
        expect(await compraDb(id)).toMatchObject({ estado: 'Pendiente', refinanciamiento_id: null, saldo_refinanciado: null });
        expect((await cuotasDb(id)).every((c) => c.estado === 'Pendiente')).toBe(true);
      }
      const cargosDespues = await s.prisma.movimientosDeudaPersona.findMany({ where: { cuota_detalle: { compra: { in: [BigInt(a), BigInt(b)] } } }, orderBy: { id: 'asc' } });
      expect(cargosDespues.map((m) => m.estado)).toEqual(cargosAntes.map((m) => m.estado));
      // y la obligación nueva no dejó cargos huérfanos
      expect(await s.prisma.movimientosDeudaPersona.count({ where: { estado: { not: 'ANULADO' }, concepto: { contains: 'Refinanciamiento' } } })).toBe(0);
    });

    it('no se puede deshacer si la obligación nueva ya tiene cuotas pagadas ni si no es un refinanciamiento', async () => {
      const { a } = await escenario();
      const r = await unificar([a]);
      await s.prisma.cuotasDetalle.updateMany({ where: { compra: BigInt(r.id), numero_cuota: 1n }, data: { estado: 'Pagado' } });
      await expect(s.refinanciamientos.deshacer(semilla.userId, r.id)).rejects.toMatchObject({ status: 409 });
      await expect(s.refinanciamientos.deshacer(semilla.userId, a)).rejects.toMatchObject({ status: 404 }); // una original no es el refinanciamiento
      await expect(s.refinanciamientos.deshacer(semilla.userId, 424242)).rejects.toMatchObject({ status: 404 });
    });

    it('un refinanciamiento histórico (vinculado a mano, capital fijo) no se puede deshacer desde la app', async () => {
      const { a } = await escenario();
      const r = await unificar([a]);
      await s.prisma.comprasCredito.update({ where: { id: BigInt(r.id) }, data: { sistema_amortizacion: 'CAPITAL_FIJO' } });
      await expect(s.refinanciamientos.deshacer(semilla.userId, r.id)).rejects.toMatchObject({ status: 409 });
      expect(await compraDb(a)).toMatchObject({ estado: 'REFINANCIADA' });
    });
  });

  describe('edición en línea (PATCH parcial)', () => {
    it('texto, estado y plástico: actualización simple que no toca las cuotas', async () => {
      const id = await crear();
      const cuotasAntes = (await cuotasDb(id)).map((c) => c.id);
      const r = await s.compras.patchCompra(id, { concepto: 'Nevera Samsung', descripcion: 'Éxito Ibagué', estado: 'Pagado' }, semilla.userId);
      expect(r).toMatchObject({ concepto: 'Nevera Samsung', descripcion: 'Éxito Ibagué', estado: 'Pagado' });
      expect((await cuotasDb(id)).map((c) => c.id)).toEqual(cuotasAntes);
    });

    it('valor, cuotas o interés recalculan la tabla (Regla 4) y devuelven la compra al día', async () => {
      const id = await crear({ numeroCuotas: 12 });
      const r = await s.compras.patchCompra(id, { numeroCuotas: 6, valorCompra: '600000' }, semilla.userId);
      expect(r).toMatchObject({ numeroCuotas: 6, valorCompra: 600_000 });
      const cuotas = await cuotasDb(id);
      expect(cuotas).toHaveLength(6);
      expect(cuotas[0].pago_total?.toString()).toBe('100000');
    });

    it('no admite estado «Refinanciada» a mano, ni un cuerpo vacío; una compra unificada solo acepta cambios de texto', async () => {
      const { a } = await escenario();
      await expect(s.compras.patchCompra(a, { estado: 'refinanciada' }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await expect(s.compras.patchCompra(a, {}, semilla.userId)).rejects.toMatchObject({ status: 400 });
      await unificar([a]);
      await expect(s.compras.patchCompra(a, { valorCompra: '1' }, semilla.userId)).rejects.toMatchObject({ status: 409 });
      expect(await s.compras.patchCompra(a, { descripcion: 'Quedó unificada en octubre' }, semilla.userId)).toMatchObject({ descripcion: 'Quedó unificada en octubre', estado: 'REFINANCIADA' });
    });

    it('el plástico debe ser de la tarjeta de la compra', async () => {
      const id = await crear();
      const otra = await s.prisma.tarjetas.create({ data: { owner_user_id: semilla.userId, franquicia: 'Master' } });
      const ajeno = await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: otra.id, owner_user_id: semilla.userId, ultimos_4: '5555', es_activo: true } });
      await expect(s.compras.patchCompra(id, { plasticoId: Number(ajeno.id) }, semilla.userId)).rejects.toMatchObject({ status: 400 });
      const propio = await s.prisma.tarjetaPlasticos.create({ data: { tarjeta_id: BigInt(semilla.tarjetaId), owner_user_id: semilla.userId, ultimos_4: '1927', es_activo: true } });
      expect(await s.compras.patchCompra(id, { plasticoId: Number(propio.id) }, semilla.userId)).toMatchObject({ plasticoId: Number(propio.id), plasticoUltimos4: '1927' });
    });
  });

  it('el periodo del refinanciamiento es el actual en Colombia', async () => {
    const { a } = await escenario();
    const r = await unificar([a]);
    const maestra = await compraDb(r.id);
    expect(periodoOf(maestra.fecha_compra as Date)).toBe(periodoOf(hoy()));
  });
});
