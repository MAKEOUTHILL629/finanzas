import { LookupService } from '../../src/modules/lookup/lookup.service';
import { crearServicios, describeDb, prepararEsquema, sembrar, Semilla, Servicios, vaciarTablas } from './db';

/** Los catálogos de los selectores contra PostgreSQL real: forma uniforme, solo lo del usuario y plásticos de las tarjetas. */
describeDb('Integración BD — lookup (catálogos de selectores)', () => {
  let s: Servicios;
  let semilla: Semilla;
  let lookup: LookupService;

  beforeAll(async () => {
    await prepararEsquema();
    s = await crearServicios();
    lookup = new LookupService(s.prisma);
  });
  afterAll(async () => {
    await s.prisma.$disconnect();
  });
  beforeEach(async () => {
    await vaciarTablas();
    semilla = await sembrar(s.prisma);
  });

  it('devuelve personas, tarjetas, cuentas y categorías del usuario con la forma uniforme', async () => {
    await s.plasticos.reemplazar(semilla.tarjetaId, { ultimos4: '1927' } as never, semilla.userId);
    await s.prisma.categorias.createMany({ data: [{ owner_user_id: null, nombre: 'Salario', tipo: 'INGRESO' }, { owner_user_id: semilla.userId, nombre: 'Mercado', tipo: 'EGRESO' }] });
    // datos de OTRO usuario: no deben aparecer
    const otro = await s.prisma.users.create({ data: { email: 'otro@example.com', role: 'user', is_active: true } });
    await s.prisma.personas.create({ data: { nombre: 'Ajena', owner_user_id: otro.id } });
    await s.prisma.cuentasFinancieras.create({ data: { owner_user_id: otro.id, nombre: 'Ajena', tipo_cuenta: 'AHORROS' } });

    const r = await lookup.catalogos(semilla.userId, ['personas', 'tarjetas', 'cuentas', 'categorias']);

    expect(r.personas?.map((p) => p.nombre)).toEqual(['Andrés', 'Felipe', 'Papá']); // por nombre
    expect(r.personas?.find((p) => p.nombre === 'Felipe')?.esPropia).toBe(true);
    expect(r.personas?.every((p) => typeof p.id === 'number')).toBe(true);
    expect(r.tarjetas?.[0]).toMatchObject({ id: semilla.tarjetaId, etiqueta: 'Visa ··1927', ultimos4Activo: '1927', plasticos: [expect.objectContaining({ ultimos4: '1927', esActivo: true })] });
    expect(r.cuentas?.map((c) => c.nombre)).toEqual(['Bancolombia', 'Nequi']);
    expect(r.cuentas?.[0]).toMatchObject({ saldoActual: 1000000, activa: true, ultimos4: '1234', tipoCuenta: 'AHORROS' });
    expect(r.categorias?.map((c) => [c.nombre, c.delSistema])).toEqual([['Mercado', false], ['Salario', true]]);
  });

  it('un usuario sin datos recibe arreglos vacíos, nunca null', async () => {
    const vacio = await s.prisma.users.create({ data: { email: 'vacio@example.com', role: 'user', is_active: true } });
    expect(await lookup.catalogos(vacio.id, ['personas', 'tarjetas', 'cuentas', 'categorias'])).toEqual({ personas: [], tarjetas: [], cuentas: [], categorias: [] });
  });
});
