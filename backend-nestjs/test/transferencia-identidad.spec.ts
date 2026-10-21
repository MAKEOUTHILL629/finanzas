/* eslint-disable @typescript-eslint/no-explicit-any */
import { TransaccionesService } from '../src/modules/transacciones/transacciones.service';
import {
  agruparPorDestinatario,
  extraerIdentidadTransferencia,
  normalizarNombreDestinatario,
  serieMensualTransferencias,
} from '../src/modules/transacciones/transferencia-identidad.util';
import { createPrismaMock, dec } from './helpers/prisma-mock';

const OWNER = 7n;

describe('extraerIdentidadTransferencia (Fase 5)', () => {
  it('extrae nombre, celular/llave y entidad de una transferencia Nequi', () => {
    const r = extraerIdentidadTransferencia('Enviaste a PAOLA ANDREA RUIZ por Nequi llave 3118895702');
    expect(r.esTransferencia).toBe(true);
    expect(r.nombreNormalizado).toBe('PAOLA ANDREA RUIZ');
    expect(r.celular).toBe('3118895702');
    expect(r.llave).toBe('3118895702');
    expect(r.entidad).toBe('Nequi');
  });

  it('extrae la cuenta destino enmascarada y la entidad Bancolombia', () => {
    const r = extraerIdentidadTransferencia('Transferencia a cuenta *4521 Bancolombia');
    expect(r.cuentaDestino).toBe('*4521');
    expect(r.entidad).toBe('Bancolombia');
    expect(r.nombreDestinatario).toBeNull();
  });

  it('extrae llaves tipo @alias y Bre-B', () => {
    const r = extraerIdentidadTransferencia('Pago por Bre-B a la llave @paola.ruiz');
    expect(r.llave).toBe('@paola.ruiz');
    expect(r.entidad).toBe('Bre-B');
  });

  it('un gasto común no se marca como transferencia y el nombre se normaliza sin tildes', () => {
    const r = extraerIdentidadTransferencia('Compra en supermercado');
    expect(r.esTransferencia).toBe(false);
    expect(normalizarNombreDestinatario('María José Ñúñez')).toBe('MARIA JOSE NUNEZ');
    expect(normalizarNombreDestinatario('ab')).toBeNull();
  });
});

describe('agruparPorDestinatario y serieMensualTransferencias', () => {
  const movs = [
    { id: 1, tipo: 'EGRESO', monto: 100000, fecha: '2026-08-05', nombreNormalizado: 'PAOLA RUIZ', llave: '3118895702', cuentaDestino: null, entidad: 'Nequi', personaId: 3, personaNombre: 'Paola Ruiz' },
    { id: 2, tipo: 'EGRESO', monto: 50000, fecha: '2026-09-07', nombreNormalizado: null, llave: null, cuentaDestino: '*4521', entidad: 'Bancolombia', personaId: 3, personaNombre: 'Paola Ruiz' },
    { id: 3, tipo: 'INGRESO', monto: 20000, fecha: '2026-09-09', nombreNormalizado: 'PAOLA RUIZ', llave: null, cuentaDestino: null, entidad: 'Nequi', personaId: 3, personaNombre: 'Paola Ruiz' },
    { id: 4, tipo: 'EGRESO', monto: 80000, fecha: '2026-09-10', nombreNormalizado: 'JUAN PEREZ', llave: null, cuentaDestino: null, entidad: null, personaId: null, personaNombre: null },
  ];

  it('agrupa por persona aunque una transferencia solo traiga la cuenta aprendida', () => {
    const grupos = agruparPorDestinatario(movs);
    expect(grupos).toHaveLength(2);
    expect(grupos[0]).toMatchObject({ nombre: 'Paola Ruiz', personaId: 3, totalEnviado: 150000, totalRecibido: 20000, cantidadOperaciones: 3, ultimaFecha: '2026-09-09' });
    expect(grupos[0].promedioTransferencia).toBeCloseTo(56666.67, 2);
    expect(grupos[0].identificadoresAsociados).toEqual(expect.arrayContaining(['3118895702', '*4521', 'PAOLA RUIZ']));
  });

  it('serie mensual separa enviado y recibido por periodo', () => {
    expect(serieMensualTransferencias(movs)).toEqual([
      { periodo: '2026-08', enviado: 100000, recibido: 0, cantidad: 1 },
      { periodo: '2026-09', enviado: 130000, recibido: 20000, cantidad: 3 },
    ]);
  });
});

describe('TransaccionesService · inteligencia de transferencias', () => {
  function setup() {
    const prisma = createPrismaMock();
    return { prisma, service: new TransaccionesService(prisma) };
  }

  const tx = (extra: Record<string, unknown> = {}) => ({
    id: 1n,
    owner_user_id: OWNER,
    tipo_transaccion: 'EGRESO',
    concepto: 'Enviaste a PAOLA ANDREA RUIZ por Nequi llave 3118895702',
    notas: null,
    comercio_canonico: null,
    monto_cop: dec(100000),
    fecha_transaccion: new Date('2026-09-07T12:00:00Z'),
    estado: 'CONFIRMADO',
    es_transferencia: false,
    es_transferencia_interna: false,
    destinatario_nombre_normalizado: null,
    llave_o_identificador: null,
    cuenta_bancaria_destino: null,
    entidad_destino: null,
    persona_asociada_id: null,
    ...extra,
  });

  it('analizarPatrones: resuelve la persona por nombre+celular, persiste metadatos y aprende la llave como alias', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findMany.mockResolvedValue([tx()]);
    prisma.personas.findMany.mockResolvedValue([{ id: 3n, nombre: 'Paola Ruiz', numero_celular: '3118895702' }]);
    prisma.aliasIdentificadoresPersona.findMany.mockResolvedValue([]);
    prisma.transacciones.update.mockResolvedValue({});
    prisma.aliasIdentificadoresPersona.upsert.mockResolvedValue({ id: 1n });

    const r = await service.analizarPatronesTransferencias(OWNER);

    expect(r).toMatchObject({ analizadas: 1, actualizadas: 1, conPersona: 1 });
    expect(r.aliasCreados).toBeGreaterThanOrEqual(1);
    const datos = prisma.transacciones.update.mock.calls[0][0].data;
    expect(datos).toMatchObject({ es_transferencia: true, destinatario_nombre_normalizado: 'PAOLA ANDREA RUIZ', llave_o_identificador: '3118895702', entidad_destino: 'Nequi', persona_asociada_id: 3n });
  });

  it('analiticaTransferencias: filtra por búsqueda (llave) y devuelve ranking, llaves, cuentas, entidades y serie', async () => {
    const { prisma, service } = setup();
    prisma.transacciones.findMany.mockResolvedValue([
      tx(),
      tx({ id: 2n, concepto: 'Transferencia a cuenta *4521 Bancolombia', monto_cop: dec(50000), persona_asociada_id: 3n, es_transferencia: true, destinatario_nombre_normalizado: null, llave_o_identificador: null, cuenta_bancaria_destino: '*4521', entidad_destino: 'Bancolombia' }),
      tx({ id: 3n, concepto: 'Compra en tienda', tipo_transaccion: 'EGRESO' }),
    ]);
    prisma.personas.findMany.mockResolvedValue([{ id: 3n, nombre: 'Paola Ruiz', numero_celular: null }]);

    const todo = await service.analiticaTransferencias(OWNER);
    expect(todo.resumen).toMatchObject({ cantidadOperaciones: 2, destinatarios: 1, totalEnviado: 150000 });
    expect(todo.porLlave.map((g: any) => g.clave)).toContain('3118895702');
    expect(todo.porCuenta.map((g: any) => g.clave)).toContain('*4521');
    expect(todo.serieMensual).toEqual([{ periodo: '2026-09', enviado: 150000, recibido: 0, cantidad: 2 }]);

    const filtrado = await service.analiticaTransferencias(OWNER, '4521');
    expect(filtrado.resumen.cantidadOperaciones).toBe(1);
  });

  it('vincularIdentificadorAPersona: crea el alias y lo aplica a las transferencias con esa cuenta; persona ajena → 404', async () => {
    const { prisma, service } = setup();
    prisma.personas.findFirst.mockResolvedValue({ id: 3n, nombre: 'Paola Ruiz' });
    prisma.aliasIdentificadoresPersona.upsert.mockResolvedValue({ id: 8n });
    prisma.transacciones.findMany.mockResolvedValue([tx({ concepto: 'Transferencia a cuenta *4521 Bancolombia', llave_o_identificador: null, cuenta_bancaria_destino: '*4521' })]);
    prisma.transacciones.update.mockResolvedValue({});

    const r = await service.vincularIdentificadorAPersona(OWNER, { personaId: 3, tipoIdentificador: 'CUENTA', valorIdentificador: '*4521' });
    expect(r).toMatchObject({ aliasId: 8, personaId: 3, transaccionesActualizadas: 1 });

    prisma.personas.findFirst.mockResolvedValue(null);
    await expect(service.vincularIdentificadorAPersona(OWNER, { personaId: 99, tipoIdentificador: 'CUENTA', valorIdentificador: '*1' })).rejects.toMatchObject({ status: 404 });
    await expect(service.vincularIdentificadorAPersona(OWNER, { personaId: 3, tipoIdentificador: 'OTRO', valorIdentificador: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});
