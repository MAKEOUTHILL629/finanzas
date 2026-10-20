import { Decimal } from '../src/config/decimal.config';
import { clasificarIntencionCorreo, generarHuellaSincronizacion } from '../src/modules/notificaciones-correo/clasificador-correo.util';
import { decidirRuta } from '../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { interpretarCuerpo } from '../src/modules/notificaciones-correo/cuerpo-correo.util';
import { ItemNormalizado, planificar } from '../src/modules/notificaciones-correo/planificador-correos';
import { CompraSnap, NotificacionSnap, SnapshotCorreos } from '../src/modules/notificaciones-correo/snapshot-correos';

const d = (v: string | number) => new Decimal(v);

function snap(over: Partial<SnapshotCorreos> = {}): SnapshotCorreos {
  return {
    ownerUserId: 1n,
    cuentas: [{ id: 1n, ultimos_4_digitos: '3698', moneda: 'COP', es_principal: true }],
    tarjetas: [{ id: 10n, descripcion: null, franquicia: 'Mastercard', ultimos_4_digitos: '9491', tasa_interes_compra: d('2'), tasa_interes_avance: null }],
    personas: [{ id: 1n, nombre: 'Yo', numero_celular: null }],
    miPersonaId: 1n,
    compras: [],
    transacciones: [],
    notificaciones: [],
    offset: '-05:00',
    trmRespaldo: null,
    ultimaTrmUsd: null,
    ...over,
  };
}

const item = (extra: Partial<ItemNormalizado> = {}): ItemNormalizado => ({
  externalMessageId: '<f1>',
  fecha: '2026-10-13',
  hora: '14:02:11',
  tipo: 'Compra',
  metodo: 'Tarjeta Credito',
  comercio: 'EXITO',
  origenRaw: 'T.Cred *9491',
  valor: '50.000',
  moneda: 'COP',
  ...extra,
});

describe('Fase 1 — clasificador semántico', () => {
  it.each([
    'Tu compra en EXITO no fue exitosa por fondos insuficientes',
    'La transacción fue declinada por cupo insuficiente',
    'Intento de compra rechazado: transacción fallida',
  ])('rechazada: %s', (texto) => {
    expect(clasificarIntencionCorreo([texto]).tipoIntencion).toBe('TRANSACCION_RECHAZADA');
    expect(clasificarIntencionCorreo([texto]).esCompraValida).toBe(false);
    expect(interpretarCuerpo(texto).rechazada).toBe(true);
  });

  it('pago de tarjeta nunca es compra', () => {
    const cuerpo = interpretarCuerpo('Recibimos el pago de tu tarjeta MasterCard por $850.000');
    expect(cuerpo.pagoTarjeta).toBe(true);
    expect(decidirRuta({ tipo: 'Compra', metodo: 'Tarjeta Credito', origenRaw: 'T.Cred *9491' }, cuerpo)).toBe('PAGO_TARJETA');
    const plan = planificar(item({ cuerpoExtraido: 'Recibimos el pago de tu tarjeta MasterCard por $850.000', comercio: 'Pago tarjeta' }), snap());
    expect(plan.analisis.tipoEvento).toBe('PAGO_TARJETA');
    expect(plan.analisis.esCompraValida).toBe(false);
    expect(plan.accion.tipo).not.toBe('CREAR_COMPRA');
  });

  it('correo rechazado queda DESCARTADO_RECHAZADO y no crea compra', () => {
    const plan = planificar(
      item({ tipo: 'Desconocido', cuerpoExtraido: 'Tu compra en EXITO no fue exitosa por fondos insuficientes' }),
      snap(),
    );
    expect(plan.estado).toBe('DESCARTADO_RECHAZADO');
    expect(plan.accion.tipo).toBe('NINGUNA');
  });

  it('huella determinista: mismo minuto/monto/últimos4/comercio = misma huella', () => {
    const fecha = new Date('2026-10-13T19:02:11Z');
    const a = generarHuellaSincronizacion({ fecha, montoCentavos: '5000000', ultimos4: '9491', comercio: 'DL*DIDI FOOD CO' });
    const b = generarHuellaSincronizacion({ fecha: new Date('2026-10-13T19:02:45Z'), montoCentavos: '5000000', ultimos4: '9491', comercio: 'DIDI FOOD' });
    const c = generarHuellaSincronizacion({ fecha, montoCentavos: '5000100', ultimos4: '9491', comercio: 'DIDI FOOD' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe('Fase 1 — resolución en cascada', () => {
  it('sin últimos 4: resuelve la tarjeta por cadena de plásticos cuando el dígito es de un plástico renovado', () => {
    const plan = planificar(item({ origenRaw: 'T.Cred *9491' }), snap());
    expect(plan.analisis.tarjetaId).toBe(10n);
    expect(plan.analisis.confianzaResolucion).toBe('CADENA_PLASTICO');
    expect(plan.accion.tipo).toBe('CREAR_COMPRA');
  });

  it('sin últimos 4: infiere la tarjeta por historial del comercio (>80 %)', () => {
    const compras: CompraSnap[] = [1, 2, 3].map((i) => ({
      id: BigInt(i), tarjetaId: 10n, fecha: '2026-09-01', valorCop: d(1000), moneda: 'COP', valorOriginal: d(1000),
      concepto: 'EXITO', cuotas: 1, interes: d(0), vinculada: true, responsables: [],
    }));
    const notificaciones: NotificacionSnap[] = compras.map((c, i) => ({
      id: BigInt(i + 1), ultimos4: null, monto: d(1000), moneda: 'COP', fecha: new Date(), comercioNorm: 'exito',
      ruta: 'COMPRA_TC', estado: 'CONCILIADO', compraId: c.id, transaccionId: null, vinculo: 'CREADA', tarjetaId: 10n,
    }));
    const plan = planificar(item({ origenRaw: 'T.Cred' }), snap({ compras, notificaciones }));
    expect(plan.analisis.tarjetaId).toBe(10n);
    expect(plan.analisis.confianzaResolucion).toBe('ALTA_INFERIDA');
  });

  it('ventana ±36 h: enlaza la compra huérfana única con monto exacto y comercio similar', () => {
    const compra: CompraSnap = {
      id: 77n, tarjetaId: 10n, fecha: '2026-10-15', valorCop: d(50000), moneda: 'COP', valorOriginal: d(50000),
      concepto: 'EXITO', cuotas: 1, interes: d(0), vinculada: false, responsables: [],
    };
    // La compra es de 2 días calendario después (fuera del ±1 día del enlace clásico) pero dentro de ±36 h.
    const plan = planificar(item({ origenRaw: 'T.Cred *0000', hora: '23:30:00' }), snap({ compras: [compra] }));
    expect(plan.accion).toMatchObject({ tipo: 'VINCULAR_COMPRA', compraId: 77n });
    expect(plan.analisis.confianzaResolucion).toBe('VENTANA_36H');
  });
});
