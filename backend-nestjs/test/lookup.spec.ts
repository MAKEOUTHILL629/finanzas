/* eslint-disable @typescript-eslint/no-explicit-any */
import { LookupService, parseTipos } from '../src/modules/lookup/lookup.service';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 7n;

describe('Lookup — parseTipos', () => {
  it('sin valor devuelve todos; acepta lista, ignora mayúsculas/espacios/repetidos', () => {
    expect(parseTipos(undefined)).toEqual(['personas', 'tarjetas', 'cuentas', 'categorias']);
    expect(parseTipos('')).toEqual(['personas', 'tarjetas', 'cuentas', 'categorias']);
    expect(parseTipos(' Personas , cuentas,personas ')).toEqual(['personas', 'cuentas']);
  });
  it('un tipo desconocido invalida toda la lista', () => {
    expect(parseTipos('personas,gatos')).toBeNull();
    expect(parseTipos('x')).toBeNull();
  });
});

describe('LookupService — forma uniforme y filtrado por usuario', () => {
  function setup() {
    const prisma = createPrismaMock();
    return { prisma, service: new LookupService(prisma) };
  }

  it('personas: id numérico, nombre siempre texto, esPropia solo para la persona enlazada al usuario', async () => {
    const { prisma, service } = setup();
    prisma.personas.findMany.mockResolvedValue([
      { id: 1n, nombre: 'Felipe', iniciales_nombre: 'FE', color_representativo: '#0071E3', linked_user_id: OWNER, email: 'f@x.co', numero_celular: '3001112233' },
      { id: 2n, nombre: null, iniciales_nombre: null, color_representativo: null, linked_user_id: null, email: null, numero_celular: null },
      { id: 3n, nombre: '  Papá ', iniciales_nombre: null, color_representativo: null, linked_user_id: 99n, email: null, numero_celular: null },
    ]);
    const r = await service.personas(OWNER);
    expect(r).toEqual([
      { id: 1, nombre: 'Felipe', iniciales: 'FE', color: '#0071E3', esPropia: true, tieneUsuario: true, email: 'f@x.co', celular: '3001112233' },
      { id: 2, nombre: 'Persona #2', iniciales: null, color: null, esPropia: false, tieneUsuario: false, email: null, celular: null },
      { id: 3, nombre: 'Papá', iniciales: null, color: null, esPropia: false, tieneUsuario: true, email: null, celular: null },
    ]);
    expect(prisma.personas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: OWNER });
  });

  it('tarjetas: etiqueta con el plástico activo, plásticos ordenados (activo primero) y números como number', async () => {
    const { prisma, service } = setup();
    prisma.tarjetas.findMany.mockResolvedValue([
      {
        id: 2n, franquicia: 'American Express', descripcion: null, tasa_interes_compra: dec('1.8895'), dia_corte: 15, dia_limite_pago: 5, cupo_total: dec('12000000'), permite_dolares: true,
        plasticos: [
          { id: 2n, ultimos_4: '9587', es_activo: false, vigente_desde: null, vigente_hasta: new Date('2024-03-16T00:00:00Z') },
          { id: 3n, ultimos_4: '1927', es_activo: true, vigente_desde: new Date('2024-12-27T00:00:00Z'), vigente_hasta: null },
        ],
      },
      { id: 3n, franquicia: null, descripcion: null, tasa_interes_compra: null, dia_corte: null, dia_limite_pago: null, cupo_total: null, permite_dolares: null, plasticos: [] },
    ]);
    const r = await service.tarjetas(OWNER);
    expect(r[0]).toMatchObject({
      id: 2, nombre: 'American Express', etiqueta: 'American Express ··1927', ultimos4Activo: '1927', tasaInteresCompra: 1.8895, cupoTotal: 12000000, permiteDolares: true,
      plasticos: [
        { id: 3, ultimos4: '1927', esActivo: true, vigenteDesde: '2024-12-27', vigenteHasta: null },
        { id: 2, ultimos4: '9587', esActivo: false, vigenteDesde: null, vigenteHasta: '2024-03-16' },
      ],
    });
    expect(r[1]).toMatchObject({ id: 3, nombre: 'Tarjeta #3', etiqueta: 'Tarjeta #3', ultimos4Activo: null, plasticos: [], permiteDolares: false, cupoTotal: null });
    expect(prisma.tarjetas.findMany.mock.calls[0][0].where).toEqual({ owner_user_id: OWNER });
  });

  it('cuentas: nombres camelCase uniformes, saldo number y activa true salvo is_active=false', async () => {
    const { prisma, service } = setup();
    prisma.cuentasFinancieras.findMany.mockResolvedValue([
      { id: 1n, nombre: 'Ahorros', tipo_cuenta: 'AHORROS', banco_entidad: 'Bancolombia', ultimos_4_digitos: '3698', moneda: 'COP', saldo_actual: dec('1500.5'), is_active: true, es_principal: true },
      { id: 2n, nombre: 'Efectivo', tipo_cuenta: 'EFECTIVO', banco_entidad: null, ultimos_4_digitos: null, moneda: 'COP', saldo_actual: dec('0'), is_active: null, es_principal: false },
      { id: 3n, nombre: 'Vieja', tipo_cuenta: 'AHORROS', banco_entidad: null, ultimos_4_digitos: null, moneda: 'USD', saldo_actual: dec('-3'), is_active: false, es_principal: false },
    ]);
    const r = await service.cuentas(OWNER);
    expect(r.map((c) => [c.id, c.activa, c.esPrincipal, c.saldoActual])).toEqual([[1, true, true, 1500.5], [2, true, false, 0], [3, false, false, -3]]);
    expect(r[0]).toEqual({ id: 1, nombre: 'Ahorros', tipoCuenta: 'AHORROS', bancoEntidad: 'Bancolombia', ultimos4: '3698', moneda: 'COP', saldoActual: 1500.5, activa: true, esPrincipal: true });
  });

  it('categorías: las del sistema y las del usuario, marcando las del sistema', async () => {
    const { prisma, service } = setup();
    prisma.categorias.findMany.mockResolvedValue([
      { id: 1n, nombre: 'Salario', tipo: 'INGRESO', color: '#34C759', icono: null, owner_user_id: null },
      { id: 2n, nombre: 'Mercado', tipo: 'EGRESO', color: null, icono: 'shopping_cart', owner_user_id: OWNER },
    ]);
    const r = await service.categorias(OWNER);
    expect(r).toEqual([
      { id: 1, nombre: 'Salario', tipo: 'INGRESO', color: '#34C759', icono: null, delSistema: true },
      { id: 2, nombre: 'Mercado', tipo: 'EGRESO', color: null, icono: 'shopping_cart', delSistema: false },
    ]);
    expect(prisma.categorias.findMany.mock.calls[0][0].where).toEqual({ OR: [{ owner_user_id: null }, { owner_user_id: OWNER }] });
  });

  it('catalogos consulta solo los tipos pedidos y devuelve arreglos vacíos (nunca null) si no hay datos', async () => {
    const { prisma, service } = setup();
    const r = await service.catalogos(OWNER, ['personas', 'cuentas']);
    expect(r).toEqual({ personas: [], cuentas: [] });
    expect(prisma.tarjetas.findMany).not.toHaveBeenCalled();
    expect(prisma.categorias.findMany).not.toHaveBeenCalled();
    expect(Object.keys(await service.catalogos(OWNER, ['personas', 'tarjetas', 'cuentas', 'categorias']))).toEqual(['personas', 'tarjetas', 'cuentas', 'categorias']);
  });
});
