/* eslint-disable @typescript-eslint/no-explicit-any */
import { Decimal } from '../src/config/decimal.config';
import { mismoComercio, nombreLegibleComercio, normalizarComercio, similitudComercio } from '../src/modules/notificaciones-correo/comercio.util';
import { interpretarCuerpo } from '../src/modules/notificaciones-correo/cuerpo-correo.util';
import { decidirRuta, motivoIgnorar, resolverCuentaOPrincipal, resolverTarjeta } from '../src/modules/notificaciones-correo/bancolombia-normalizer.util';
import { encontrarPersona, nombreContraparte } from '../src/modules/notificaciones-correo/persona-match.util';
import { ItemNormalizado, planificar } from '../src/modules/notificaciones-correo/planificador-correos';
import { elegirPlantilla } from '../src/modules/notificaciones-correo/plantilla-compra.util';
import { aplicarPlanASnapshot, CompraSnap, NotificacionSnap, SnapshotCorreos } from '../src/modules/notificaciones-correo/snapshot-correos';

const d = (v: string | number) => new Decimal(v);

describe('comercio.util — reconocer «el mismo comercio»', () => {
  it.each([
    ['DL*DIDI FOOD CO', 'didi food'],
    ['DLO*DIDI FOOD CO PAY', 'didi food'],
    ['DIDI FOOD*DL', 'didi food'],
    ['DIDI FOODS', 'didi food'],
    ['DL*DIDI RIDES CO', 'didi ride'],
    ['DLO*DIDI', 'didi'],
    ['AMAZON.COM', 'amazon'],
    ['RAPPI RESTAURANTES', 'rappi restaurante'],
    ['RAPPI COLOMBIA*DL', 'rappi'],
    ['UBER BV USD-USD COLO', 'uber'],
    ['MERCADOPAGO COLOMBIA', 'mercadopago'],
    ['  PAYU*CINEMARK ', 'cinemark'],
    ['', ''],
    [null, ''],
  ])('"%s" → "%s"', (texto, esperado) => {
    expect(normalizarComercio(texto as string | null)).toBe(esperado);
  });

  it('si todo eran palabras genéricas conserva lo alfanumérico', () => {
    expect(normalizarComercio('CO SAS')).toBe('co sas');
  });

  it('similitud: idénticos, misma marca (con/sin detalle) y marcas distintas', () => {
    expect(similitudComercio('didi food', 'didi food')).toBe(1);
    expect(similitudComercio('didi', 'didi food')).toBe(0.6);
    expect(similitudComercio('didi food', 'didi ride')).toBe(0.5);
    expect(similitudComercio('didi food', 'rappi restaurante')).toBe(0);
    expect(similitudComercio('', 'didi')).toBe(0);
    expect(mismoComercio(normalizarComercio('DL*DIDI FOOD CO'), normalizarComercio('DIDI FOODS'))).toBe(true);
    expect(mismoComercio('didi food', 'didi ride')).toBe(false);
    expect(mismoComercio('didi', 'didi food')).toBe(true);
  });

  it('nombre legible sin pasarela ni palabras genéricas', () => {
    expect(nombreLegibleComercio('DL*DIDI FOOD CO')).toBe('Didi Food');
    expect(nombreLegibleComercio('AMAZON.COM')).toBe('Amazon');
    expect(nombreLegibleComercio('')).toBe('');
  });
});

describe('cuerpo-correo.util — lo que el Apps Script no clasifica', () => {
  it('transferencia recibida (formato moderno, con llave)', () => {
    const c = interpretarCuerpo(
      'Bancolombia: LUIS, recibiste una transferencia de CARLOS ANDRES HERNANDEZ GIRALDO por $1,125,000.00 en tu cuenta *4248 conectada a la llave @luish9910 el 15/10/26 a las 15:03.',
    );
    expect(c.recibida).toEqual({ contraparte: 'CARLOS ANDRES HERNANDEZ GIRALDO', monto: '1,125,000.00', cuenta4: '4248', llave: '@luish9910' });
    expect(c.ultimos4).toBe('4248');
  });

  it('transferencia recibida (formato antiguo, con tildes y doble asterisco)', () => {
    const c = interpretarCuerpo('Bancolombia: Recibiste una transferencia por $4,200,000 de LUIS HERNÁNDEZ en tu cuenta **3698, el 25/04/2026 a las 15:10.');
    expect(c.recibida).toMatchObject({ contraparte: 'LUIS HERNANDEZ', monto: '4,200,000', cuenta4: '3698' });
  });

  it('transferencia enviada por Bre-B', () => {
    const c = interpretarCuerpo('Bancolombia: LUIS, transferiste $50,000.00 a la llave 3044487126 desde tu cuenta *4248 a JUAN SANCHEZ el 14/10/26 a las 09:17. Con Bre-b es de una y gratis.');
    expect(c.enviada).toEqual({ contraparte: 'JUAN SANCHEZ', monto: '50,000.00', cuenta4: '4248', llave: '3044487126' });
  });

  it('compra rechazada y aviso de inscripción', () => {
    expect(interpretarCuerpo('Bancolombia: tu compra con T.Credito *9491 por COP204.676,00 no fue exitosa por fondos insuficientes. 00:16 03/10/2026.').rechazada).toBe(true);
    expect(interpretarCuerpo('Notificación Informativa Bancolombia te notifica que la inscripción al servicio de Clave Dinámica solicitada en BANCOLOMBIA APP ha sido exitosa.').informativo).toBe(true);
    expect(interpretarCuerpo('Compraste $50.000 en EXITO con tu T.Cred *1927').rechazada).toBe(false);
  });

  it('avance de tarjeta a una cuenta', () => {
    const c = interpretarCuerpo('Notificación Transaccional Bancolombia le informa Avance por $7,800,000 en SUC VIRTUAL. Hora 12:47 Fecha 22/08/2022 T.cred *7293 a la cta *3698. Inquietudes al 6045109095.');
    expect(c.avance).toEqual({ monto: '7,800,000', tarjeta4: '7293', cuentaDestino4: '3698' });
  });

  it('«en tu cuenta de Ahorros» sin número', () => {
    expect(interpretarCuerpo('Recibiste un pago de Nomina de PRAGMA S A por $9,957,130.00 en tu cuenta de Ahorros el 24/04/2026').cuentaSinNumero).toBe(true);
    expect(interpretarCuerpo('Recibiste un pago por $1.000 en tu cuenta *3698').cuentaSinNumero).toBe(false);
  });

  it('texto vacío o irrelevante no inventa nada', () => {
    for (const t of [null, undefined, '', '   ', 'Hola, esto no es un correo del banco']) {
      expect(interpretarCuerpo(t as string | null)).toMatchObject({ rechazada: false, informativo: false, recibida: null, enviada: null, avance: null, ultimos4: null });
    }
  });
});

describe('persona-match.util — contraparte → persona registrada', () => {
  const personas = [
    { id: 1n, nombre: 'Luis Felipe Hernández Chica', numero_celular: '3043866055' },
    { id: 2n, nombre: 'Carlos Andrés Hernández Giraldo', numero_celular: '310' },
    { id: 4n, nombre: 'Luis Fernando Hernández Arcia', numero_celular: '3125580420' },
    { id: 5n, nombre: 'Alicia Buitrago', numero_celular: null },
    { id: 6n, nombre: 'Familia Hernandez', numero_celular: null },
  ];

  it('nombre completo sin tildes ni mayúsculas', () => {
    expect(encontrarPersona(personas, 'CARLOS ANDRES HERNANDEZ GIRALDO')?.id).toBe(2n);
    expect(encontrarPersona(personas, 'ALICIA BUITRAGO')?.id).toBe(5n);
  });

  it('nombre abreviado inequívoco; ambiguo → null', () => {
    expect(encontrarPersona(personas, 'Carlos Hernandez')?.id).toBe(2n);
    expect(encontrarPersona(personas, 'LUIS HERNANDEZ')).toBeNull(); // Felipe y Fernando
    expect(encontrarPersona(personas, 'Hernandez')).toBeNull(); // una sola palabra no basta
    expect(encontrarPersona(personas, 'JUAN SANCHEZ')).toBeNull();
    expect(encontrarPersona(personas, null)).toBeNull();
  });

  it('el celular de la llave identifica a la persona aunque el nombre no coincida', () => {
    expect(encontrarPersona(personas, 'Luchito', '3125580420')?.id).toBe(4n);
    expect(encontrarPersona(personas, 'Luchito', '@plata3125580420')?.id).toBe(4n);
    expect(encontrarPersona(personas, 'Luchito', '3999999999')).toBeNull();
  });

  it('nombreContraparte descarta números de cuenta y llaves', () => {
    expect(nombreContraparte('JUAN SANCHEZ (Llave: 3044487126)')).toBe('JUAN SANCHEZ');
    expect(nombreContraparte('Cuenta *3043865837')).toBeNull();
    expect(nombreContraparte('Llave: 3044487126')).toBeNull();
    expect(nombreContraparte('Destino: *1550')).toBeNull();
    expect(nombreContraparte('EXITO')).toBeNull();
    expect(nombreContraparte(null)).toBeNull();
  });
});

describe('bancolombia-normalizer — enrutamiento con el cuerpo del correo', () => {
  it('compra o avance con T.Cred se enruta a COMPRA_TC aunque el método sea «Boton Bancolombia»', () => {
    expect(decidirRuta({ tipo: 'Compra', metodo: 'Boton Bancolombia', origenRaw: 'T.Cred *1927' })).toBe('COMPRA_TC');
    expect(decidirRuta({ tipo: 'Avance', metodo: 'Cuenta Ahorros/Corriente', origenRaw: 'T.cred *7293' })).toBe('COMPRA_TC');
    expect(decidirRuta({ tipo: 'Compra', metodo: 'Boton Bancolombia', origenRaw: 'Cuenta *3698' })).toBe('EGRESO');
  });

  it('«Desconocido» con transferencia recibida → INGRESO; rechazada o inscripción → IGNORAR', () => {
    const recibida = interpretarCuerpo('recibiste una transferencia de ALICIA BUITRAGO por $2,000,000.00 en tu cuenta *4248');
    expect(decidirRuta({ tipo: 'Desconocido', metodo: 'Transfiya/Bre-b', origenRaw: '' }, recibida)).toBe('INGRESO');
    expect(decidirRuta({ tipo: 'Desconocido', metodo: 'Transfiya/Bre-b', origenRaw: '' })).toBe('SIN_RUTA');

    const rechazada = interpretarCuerpo('tu compra con T.Credito *9491 no fue exitosa por fondos insuficientes');
    expect(decidirRuta({ tipo: 'Desconocido', metodo: 'Tarjeta Credito', origenRaw: 'Tarjeta Crédito' }, rechazada)).toBe('IGNORAR');
    expect(motivoIgnorar({ tipo: 'Desconocido', metodo: 'Tarjeta Credito' }, rechazada)).toBe('compra_rechazada_o_no_exitosa');
    expect(motivoIgnorar({ tipo: 'Compra', metodo: 'QR', esErrorParsing: true })).toBe('aviso_informativo_o_error_de_parseo');
    expect(motivoIgnorar({ tipo: 'Compra', metodo: 'QR' })).toBeNull();
  });

  it('la columna Tarjetas.ultimos_4_digitos tiene prioridad sobre el texto de la descripción', () => {
    const tarjetas = [
      { id: 1n, descripcion: 'Mastercard', franquicia: 'Mastercard', ultimos_4_digitos: '9491' },
      { id: 2n, descripcion: 'Amex', franquicia: 'American Express', ultimos_4_digitos: '1927,9587' },
      { id: 3n, descripcion: 'Visa *7293', franquicia: 'Visa', ultimos_4_digitos: null },
    ];
    expect(resolverTarjeta(tarjetas, '9587')?.id).toBe(2n);
    expect(resolverTarjeta(tarjetas, '9491')?.id).toBe(1n);
    expect(resolverTarjeta(tarjetas, '7293')?.id).toBe(3n); // heredado: dígitos en la descripción
    expect(resolverTarjeta(tarjetas, '0000')).toBeNull();
    // dos tarjetas con los mismos dígitos → ambiguo, no se adivina
    expect(resolverTarjeta([...tarjetas, { id: 9n, descripcion: null, franquicia: null, ultimos_4_digitos: '9491' }], '9491')).toBeNull();
  });

  it('cuenta principal solo cuando el aviso NO trae número', () => {
    const cuentas = [
      { id: 1n, ultimos_4_digitos: '3698,4278', es_principal: true },
      { id: 2n, ultimos_4_digitos: '4248', es_principal: false },
    ];
    expect(resolverCuentaOPrincipal(cuentas, '4248')?.id).toBe(2n);
    expect(resolverCuentaOPrincipal(cuentas, null)?.id).toBe(1n);
    expect(resolverCuentaOPrincipal(cuentas, '0000')).toBeNull(); // número desconocido: no se adivina
    expect(resolverCuentaOPrincipal(cuentas.map((c) => ({ ...c, es_principal: false })), null)).toBeNull();
    expect(resolverCuentaOPrincipal(cuentas.map((c) => ({ ...c, es_principal: true })), null)).toBeNull(); // dos principales: ambiguo
  });
});

// ───────────────────────────── planificador ─────────────────────────────

const PERSONAS = [
  { id: 1n, nombre: 'Luis Felipe Hernández Chica', numero_celular: null },
  { id: 2n, nombre: 'Carlos Andrés Hernández Giraldo', numero_celular: null },
  { id: 5n, nombre: 'Alicia Buitrago', numero_celular: null },
];

function snap(over: Partial<SnapshotCorreos> = {}): SnapshotCorreos {
  return {
    ownerUserId: 1n,
    cuentas: [
      { id: 1n, ultimos_4_digitos: '3698,4278', moneda: 'COP', es_principal: true },
      { id: 2n, ultimos_4_digitos: '4248', moneda: 'COP', es_principal: false },
    ],
    tarjetas: [
      { id: 10n, descripcion: null, franquicia: 'American Express', ultimos_4_digitos: '1927,9587', tasa_interes_compra: d('1.8895'), tasa_interes_avance: d('2.1') },
      { id: 11n, descripcion: null, franquicia: 'Mastercard', ultimos_4_digitos: '9491', tasa_interes_compra: null, tasa_interes_avance: null },
    ],
    personas: PERSONAS,
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

const compra = (id: number, over: Partial<CompraSnap> = {}): CompraSnap => ({
  id: BigInt(id),
  tarjetaId: 10n,
  fecha: '2026-08-15',
  valorCop: d(50000),
  moneda: 'COP',
  valorOriginal: d(50000),
  concepto: 'DIDI FOODS',
  cuotas: 1,
  interes: d(0),
  vinculada: false,
  responsables: [],
  ...over,
});

/** Compra del mismo día y monto que `compraTc()` (candidata a enlazarse). */
const delDia = (id: number, over: Partial<CompraSnap> = {}): CompraSnap => compra(id, { fecha: '2026-10-13', ...over });

const felipe100 = [{ personaId: 1n, porcentaje: d(100), cuotas: 1 }];

/** Notificación ya REVISADA (CONCILIADO) que enlaza una compra al comercio: es lo que alimenta las plantillas. */
const revisada = (id: number, compraId: number, comercioNorm: string, over: Partial<NotificacionSnap> = {}): NotificacionSnap => ({
  id: BigInt(id),
  ultimos4: '1927',
  monto: d(1000 + id),
  moneda: 'COP',
  fecha: new Date('2026-09-01T15:00:00Z'),
  comercioNorm,
  ruta: 'COMPRA_TC',
  estado: 'CONCILIADO',
  compraId: BigInt(compraId),
  transaccionId: null,
  vinculo: 'EXISTENTE',
  ...over,
});

const compraTc = (extra: Partial<ItemNormalizado> = {}): ItemNormalizado => ({
  externalMessageId: '<c1>',
  fecha: '2026-10-13',
  hora: '14:02:11',
  tipo: 'Compra',
  metodo: 'Tarjeta Credito',
  comercio: 'DL*DIDI FOOD CO',
  origenRaw: 'T.Cred *1927',
  valor: '50.000',
  moneda: 'COP',
  ...extra,
});

const cuentaItem = (extra: Partial<ItemNormalizado> = {}): ItemNormalizado => ({
  externalMessageId: '<t1>',
  fecha: '2026-10-14',
  hora: '09:17:00',
  tipo: 'Transferencia',
  metodo: 'Transfiya/Bre-b',
  comercio: 'JUAN SANCHEZ (Llave: 3044487126)',
  origenRaw: 'Cuenta *4248',
  valor: '50.000',
  moneda: 'COP',
  ...extra,
});

describe('planificador — compras con tarjeta de crédito', () => {
  it('una compra que YA existe (misma tarjeta, fecha y monto) se enlaza y no se duplica', () => {
    const s = snap({ compras: [delDia(500)] });
    const plan = planificar(compraTc(), s);
    expect(plan).toMatchObject({ estado: 'CONCILIADO', motivo: 'vinculada_a_compra_existente', vinculo: 'EXISTENTE', accion: { tipo: 'VINCULAR_COMPRA', compraId: 500n } });
    expect(plan.analisis.tarjetaId).toBe(10n);
  });

  it('cada compra existente se enlaza a UN solo correo: el segundo, idéntico, es otra compra', () => {
    const s = snap({ compras: [delDia(500)] });
    const primero = planificar(compraTc({ externalMessageId: '<a>' }), s, { notificacionId: 1n });
    aplicarPlanASnapshot(s, primero, { notificacionId: 1n }, new Date('2026-10-13T19:02:11Z'));
    const segundo = planificar(compraTc({ externalMessageId: '<b>', hora: '20:30:00' }), s, { notificacionId: 2n });
    expect(primero.accion.tipo).toBe('VINCULAR_COMPRA');
    expect(segundo.accion.tipo).toBe('CREAR_COMPRA'); // hay otra compra igual, pero 6 h después: no es duplicado de correo
  });

  it('tolera un día de diferencia, y exige el mismo monto', () => {
    expect(planificar(compraTc(), snap({ compras: [delDia(500, { fecha: '2026-10-12' })] })).accion).toMatchObject({ tipo: 'VINCULAR_COMPRA' });
    expect(planificar(compraTc(), snap({ compras: [delDia(500, { fecha: '2026-10-15' })] })).accion.tipo).not.toBe('VINCULAR_COMPRA');
    expect(planificar(compraTc(), snap({ compras: [delDia(500, { valorCop: d(50001) })] })).accion.tipo).not.toBe('VINCULAR_COMPRA');
  });

  it('con la tarjeta del correo conocida, no enlaza compras de otra tarjeta', () => {
    const plan = planificar(compraTc(), snap({ compras: [delDia(500, { tarjetaId: 11n })] }));
    expect(plan.accion.tipo).toBe('CREAR_COMPRA');
  });

  it('tarjeta desconocida: enlaza si la coincidencia es inequívoca (y aprende la tarjeta); si es ambigua, queda pendiente', () => {
    const unica = planificar(compraTc({ origenRaw: 'T.Cred *0000' }), snap({ compras: [delDia(500)] }));
    expect(unica).toMatchObject({ estado: 'CONCILIADO', accion: { tipo: 'VINCULAR_COMPRA', compraId: 500n } });
    expect(unica.analisis.tarjetaId).toBe(10n);

    const ambigua = planificar(compraTc({ origenRaw: 'T.Cred *0000' }), snap({ compras: [delDia(500), delDia(501, { tarjetaId: 11n })] }));
    expect(ambigua).toMatchObject({ estado: 'PENDIENTE', motivo: 'tarjeta_no_identificada', accion: { tipo: 'NINGUNA' } });

    const ninguna = planificar(compraTc({ origenRaw: 'T.Cred *0000' }), snap());
    expect(ninguna).toMatchObject({ estado: 'PENDIENTE', motivo: 'tarjeta_no_identificada' });
  });

  it('compra en USD: se enlaza por el valor original en dólares', () => {
    const s = snap({ compras: [delDia(500, { moneda: 'USD', valorOriginal: d('0.99'), valorCop: d(4158) })], ultimaTrmUsd: d(4200) });
    const plan = planificar(compraTc({ comercio: 'Audible', valor: 'USD0,99'.replace('USD', ''), moneda: 'USD' }), s);
    // "0,99" con moneda USD es 0.99 (coma decimal)
    expect(plan.accion).toMatchObject({ tipo: 'VINCULAR_COMPRA', compraId: 500n });
  });

  it('sin plantilla (comercio nuevo): 1 cuota, sin responsables, PENDIENTE para que el usuario la complete', () => {
    const plan = planificar(compraTc({ comercio: 'EXITO' }), snap());
    expect(plan).toMatchObject({ estado: 'PENDIENTE', motivo: 'compra_tc_creada_a_1_cuota', vinculo: 'CREADA', plantilla: null });
    expect(plan.accion).toMatchObject({ tipo: 'CREAR_COMPRA', tarjetaId: 10n, concepto: 'EXITO', numeroCuotas: 1, responsables: [] });
    expect((plan.accion as any).interes.toString()).toBe('1.8895'); // tasa de compra de la tarjeta
  });

  it('con plantilla: copia cuotas, responsables y porcentajes del mismo comercio (DIDI FOOD → 1 cuota, Felipe 100 %)', () => {
    const compras = [compra(1, { concepto: 'DIDI FOODS', responsables: felipe100 }), compra(2, { concepto: 'PIZZAS DIDI', responsables: felipe100 }), compra(3, { concepto: 'DIDI FOOD', responsables: felipe100 })];
    const notificaciones = [revisada(1, 1, 'didi food'), revisada(2, 2, 'didi food'), revisada(3, 3, 'didi food')];
    const plan = planificar(compraTc({ comercio: 'DLO*DIDI FOOD CO PAY' }), snap({ compras, notificaciones }));

    expect(plan).toMatchObject({ estado: 'CONCILIADO', motivo: 'compra_creada_desde_plantilla', vinculo: 'CREADA', plantilla: { muestras: 3, confianza: 1, origen: 'historial' } });
    expect(plan.accion).toMatchObject({ tipo: 'CREAR_COMPRA', numeroCuotas: 1 });
    expect((plan.accion as any).responsables).toEqual([{ personaId: 1n, porcentaje: d(100), cuotas: 1 }]);
    // el usuario escribe conceptos distintos para el mismo comercio: se usa el nombre limpio del comercio
    expect((plan.accion as any).concepto).toBe('Didi Food');
  });

  it('si un concepto domina el historial, se reutiliza tal cual lo escribe el usuario', () => {
    const compras = [1, 2, 3].map((i) => compra(i, { concepto: 'Youtube Premiun', responsables: felipe100, fecha: `2026-0${i}-25` }));
    const notificaciones = [1, 2, 3].map((i) => revisada(i, i, 'google youtubepr'));
    const plan = planificar(compraTc({ comercio: 'DLO*GOOGLE YOUTUBEPR', valor: '41.900' }), snap({ compras, notificaciones }));
    expect((plan.accion as any).concepto).toBe('Youtube Premiun');
  });

  it('un patrón minoritario no manda: gana el dominante; si hay empate, no hay plantilla', () => {
    const otro = [{ personaId: 2n, porcentaje: d(50), cuotas: 1 }];
    const dom = [1, 2, 3, 4].map((i) => compra(i, { responsables: felipe100, fecha: `2026-09-0${i}` }));
    const min = [5, 6].map((i) => compra(i, { responsables: otro, fecha: `2026-08-0${i - 4}` }));
    const s = snap({ compras: [...dom, ...min], notificaciones: [...dom, ...min].map((c) => revisada(Number(c.id), Number(c.id), 'didi food')) });
    expect((planificar(compraTc(), s).accion as any).responsables).toEqual(felipe100);

    const mitad = snap({
      compras: [compra(1, { responsables: felipe100, fecha: '2026-09-02' }), compra(2, { responsables: otro, fecha: '2026-09-01' })],
      notificaciones: [revisada(1, 1, 'didi food'), revisada(2, 2, 'didi food')],
    });
    // mitad y mitad pero las 5 más recientes pesan igual: 50 % → alcanza el mínimo, gana el más reciente
    expect(elegirPlantilla(mitad, 'didi food')?.confianza).toBe(0.5);
  });

  it('solo se aprende de lo revisado: una compra creada sin tocar (PENDIENTE) no es una preferencia', () => {
    const compras = [1, 2, 3].map((i) => compra(i, { responsables: [] }));
    const notificaciones = [1, 2, 3].map((i) => revisada(i, i, 'didi food', { estado: 'PENDIENTE', vinculo: 'CREADA' }));
    const plan = planificar(compraTc(), snap({ compras, notificaciones }));
    expect(plan).toMatchObject({ estado: 'PENDIENTE', motivo: 'compra_tc_creada_a_1_cuota', plantilla: null });
  });

  it('sin historial de correos, usa las compras registradas a mano con un concepto parecido', () => {
    const compras = [compra(1, { concepto: 'DIDI FOODS', responsables: felipe100 }), compra(2, { concepto: 'DIDI FOOD', responsables: felipe100 })];
    const plan = planificar(compraTc(), snap({ compras }));
    expect(plan.plantilla).toMatchObject({ origen: 'concepto_similar', muestras: 2 });
    expect((plan.accion as any).responsables).toEqual(felipe100);
  });

  it('el avance de tarjeta no usa plantilla y lleva la tasa de avance', () => {
    const s = snap({ compras: [compra(1, { responsables: felipe100 }), compra(2, { responsables: felipe100 })], notificaciones: [revisada(1, 1, 'cajero'), revisada(2, 2, 'cajero')] });
    const plan = planificar(compraTc({ tipo: 'Avance', comercio: 'CAJERO', metodo: 'Boton Bancolombia', origenRaw: 'T.cred *1927' }), s);
    expect(plan.accion).toMatchObject({ tipo: 'CREAR_COMPRA', esAvance: true, concepto: 'Avance - CAJERO' });
    expect((plan.accion as any).interes.toString()).toBe('2.1');
    expect((plan.accion as any).responsables).toEqual([]);
  });

  it('compra en USD nueva: guarda dólares y TRM; sin TRM queda pendiente', () => {
    const conTrm = planificar(compraTc({ comercio: 'Audible', valor: '49.99', moneda: 'USD' }), snap({ ultimaTrmUsd: d(4200) }));
    expect(conTrm.accion).toMatchObject({ tipo: 'CREAR_COMPRA', moneda: 'USD' });
    expect((conTrm.accion as any).valorCop.toString()).toBe('209958');
    expect((conTrm.accion as any).tasa.toString()).toBe('4200');
    expect(planificar(compraTc({ valor: '49.99', moneda: 'USD' }), snap())).toMatchObject({ estado: 'PENDIENTE', motivo: 'trm_no_disponible' });
    expect((planificar(compraTc({ valor: '10', moneda: 'USD' }), snap({ trmRespaldo: d('4000.5') })).accion as any).tasa.toString()).toBe('4000.5');
  });

  it('correo rechazado por fondos insuficientes → IGNORADO, no es un gasto', () => {
    const plan = planificar(
      {
        externalMessageId: '<r>',
        fecha: '2026-10-03',
        hora: '00:16:00',
        tipo: 'Desconocido',
        metodo: 'Tarjeta Credito',
        origenRaw: 'Tarjeta Crédito',
        valor: '204676',
        cuerpoExtraido: 'Bancolombia: tu compra con T.Credito *9491 por COP204.676,00 no fue exitosa por fondos insuficientes. 00:16 03/10/2026.',
      },
      snap(),
    );
    expect(plan).toMatchObject({ estado: 'DESCARTADO_RECHAZADO', motivo: 'compra_rechazada_o_no_exitosa', accion: { tipo: 'NINGUNA' } });
  });
});

describe('planificador — duplicados y fecha de corte', () => {
  const previo = (over: Partial<NotificacionSnap> = {}): NotificacionSnap =>
    revisada(1, 500, 'didi food', { monto: d(50000), fecha: new Date('2026-10-13T19:02:00Z'), estado: 'CONCILIADO', vinculo: 'CREADA', ...over });

  it('el mismo hecho avisado dos veces (misma tarjeta, monto y minuto) → el segundo es DUPLICADO del primero', () => {
    const plan = planificar(compraTc({ externalMessageId: '<otro>', hora: '14:04:00' }), snap({ notificaciones: [previo()], compras: [delDia(500, { vinculada: true })] }));
    expect(plan).toMatchObject({ estado: 'IGNORADO', motivo: 'duplicado_de_correo', vinculo: 'DUPLICADO', notificacionOriginalId: 1n, accion: { tipo: 'DUPLICADO', originalId: 1n } });
  });

  it('pasada la ventana de 10 min, o con otra tarjeta/monto/comercio, NO es duplicado', () => {
    const base = snap({ notificaciones: [previo()], compras: [delDia(500, { vinculada: true })] });
    expect(planificar(compraTc({ hora: '14:30:00' }), base).accion.tipo).toBe('CREAR_COMPRA');
    expect(planificar(compraTc({ hora: '14:04:00', origenRaw: 'T.Cred *9491' }), base).accion.tipo).toBe('CREAR_COMPRA');
    expect(planificar(compraTc({ hora: '14:04:00', valor: '50.001' }), base).accion.tipo).toBe('CREAR_COMPRA');
    expect(planificar(compraTc({ hora: '14:04:00', comercio: 'EXITO' }), base).accion.tipo).toBe('CREAR_COMPRA');
  });

  it('un correo no se compara consigo mismo ni con uno posterior (reproceso cronológico)', () => {
    const yo = previo({ id: 7n });
    const s = snap({ notificaciones: [yo] });
    expect(planificar(compraTc({ hora: '14:02:00' }), s, { notificacionId: 7n }).motivo).not.toBe('duplicado_de_correo');
    const posterior = previo({ id: 8n, fecha: new Date('2026-10-13T19:05:00Z') });
    expect(planificar(compraTc({ hora: '14:02:00' }), snap({ notificaciones: [posterior] }), { notificacionId: 7n }).motivo).not.toBe('duplicado_de_correo');
  });

  it('un correo ignorado por el usuario no sirve de original; uno ya marcado duplicado sí remite al original auténtico', () => {
    const ignorado = previo({ estado: 'IGNORADO', vinculo: null });
    expect(planificar(compraTc({ hora: '14:03:00' }), snap({ notificaciones: [ignorado] })).motivo).not.toBe('duplicado_de_correo');

    const original = previo();
    const dup = previo({ id: 2n, estado: 'IGNORADO', vinculo: 'DUPLICADO', fecha: new Date('2026-10-13T19:02:30Z') });
    const plan = planificar(compraTc({ hora: '14:03:00' }), snap({ notificaciones: [dup, original], compras: [delDia(500, { vinculada: true })] }));
    expect(plan.notificacionOriginalId).toBe(1n);
  });

  it('con fecha de corte: lo anterior solo se enlaza; si no hay equivalente queda PENDIENTE sin registrar nada', () => {
    const corte = new Date('2026-06-02T05:00:00Z');
    const antiguo = compraTc({ fecha: '2026-03-10' });
    expect(planificar(antiguo, snap(), { desde: corte })).toMatchObject({ estado: 'PENDIENTE', motivo: 'historico_sin_registro_previo', accion: { tipo: 'NINGUNA' } });
    expect(planificar(antiguo, snap({ compras: [delDia(500, { fecha: '2026-03-10' })] }), { desde: corte }).accion.tipo).toBe('VINCULAR_COMPRA');
    expect(planificar(compraTc({ fecha: '2026-06-10' }), snap(), { desde: corte }).accion.tipo).toBe('CREAR_COMPRA');

    const cuentaAntigua = planificar(cuentaItem({ fecha: '2026-03-10' }), snap(), { desde: corte });
    expect(cuentaAntigua).toMatchObject({ estado: 'PENDIENTE', motivo: 'historico_sin_registro_previo' });
  });
});

describe('planificador — transferencias, Bre-B, retiros y pagos con cuenta', () => {
  it('Bre-B enviado → EGRESO en la cuenta de los últimos 4; reconoce a la persona por la llave y el nombre', () => {
    const plan = planificar(cuentaItem({ comercio: 'Carlos Andres Hernandez Giraldo (Llave: 3108892985)', origenRaw: 'Cuenta *4248', valor: '250.000' }), snap());
    expect(plan).toMatchObject({ estado: 'CONCILIADO', motivo: 'transaccion_confirmada_automaticamente', vinculo: 'CREADA', accion: { tipo: 'CREAR_TRANSACCION' } });
    expect(plan.analisis).toMatchObject({ ruta: 'EGRESO', cuentaId: 2n, personaId: 2n });
    const datos = (plan.accion as any).datos;
    expect(datos).toMatchObject({ tipoTransaccion: 'EGRESO', cuentaOrigenId: 2, cuentaDestinoId: null, estado: 'CONFIRMADO', origenRegistro: 'EMAIL_AUTO' });
    expect(datos.notas).toContain('Contraparte: Carlos Andrés Hernández Giraldo');
  });

  it('transferencia a un número de cuenta (sin nombre) no inventa a la persona', () => {
    const plan = planificar(cuentaItem({ metodo: 'Cuenta Ahorros/Corriente', comercio: 'Cuenta *3195974366' }), snap());
    expect(plan.analisis.personaId).toBeNull();
    expect(plan.accion.tipo).toBe('CREAR_TRANSACCION');
  });

  it('transferencia RECIBIDA (tipo «Desconocido») → INGRESO con la persona que la envía', () => {
    const plan = planificar(
      {
        externalMessageId: '<in>',
        fecha: '2026-10-06',
        hora: '18:45:00',
        tipo: 'Desconocido',
        metodo: 'Transfiya/Bre-b',
        comercio: '',
        origenRaw: '',
        valor: '2000000',
        cuerpoExtraido: 'Bancolombia: luis, recibiste una transferencia de ALICIA BUITRAGO por $2,000,000.00 en tu cuenta *4248 conectada a la llave @luish9910 el 06/10/26 a las 18:45.',
      },
      snap(),
    );
    expect(plan.analisis).toMatchObject({ ruta: 'INGRESO', ultimos4: '4248', cuentaId: 2n, personaId: 5n });
    expect((plan.accion as any).datos).toMatchObject({ tipoTransaccion: 'INGRESO', cuentaDestinoId: 2, cuentaOrigenId: null, concepto: 'Transferencia recibida de ALICIA BUITRAGO' });
  });

  it('un pago que el banco avisa «en tu cuenta de Ahorros» (sin número) va a la cuenta principal; sin principal queda pendiente', () => {
    const nomina = { tipo: 'Ingreso', metodo: 'Cuenta Ahorros', comercio: 'PRAGMA S A', origenRaw: 'cuenta de Ahorros', valor: '9957130' } as const;
    const item = (): ItemNormalizado => ({ externalMessageId: '<n>', fecha: '2026-04-24', hora: '11:53:00', ...nomina });
    expect((planificar(item(), snap()).accion as any).datos).toMatchObject({ tipoTransaccion: 'INGRESO', cuentaDestinoId: 1 });
    const sinPrincipal = snap({ cuentas: snap().cuentas.map((c) => ({ ...c, es_principal: false })) });
    expect(planificar(item(), sinPrincipal)).toMatchObject({ estado: 'PENDIENTE', motivo: 'cuenta_no_identificada' });
  });

  it('compra con tarjeta débito: la cuenta se identifica por los dígitos de la tarjeta débito', () => {
    const plan = planificar(cuentaItem({ tipo: 'Compra', metodo: 'Tarjeta Debito', comercio: 'MARKET PASTEUR CE', origenRaw: 'T.Deb *4278', valor: '11.773' }), snap());
    expect(plan.analisis.cuentaId).toBe(1n);
    expect((plan.accion as any).datos).toMatchObject({ tipoTransaccion: 'EGRESO', cuentaOrigenId: 1 });
  });

  it('una transacción registrada a mano (misma cuenta, monto y día) se enlaza en vez de duplicarse', () => {
    const manual = { id: 900n, tipo: 'EGRESO', estado: 'CONFIRMADO', cuentaOrigenId: 2n, cuentaDestinoId: null, tarjetaPagadaId: null, montoCop: d(50000), fecha: new Date('2026-10-14T05:00:00Z'), vinculada: false };
    const plan = planificar(cuentaItem(), snap({ transacciones: [manual] }));
    expect(plan).toMatchObject({ estado: 'CONCILIADO', motivo: 'vinculada_a_transaccion_existente', vinculo: 'EXISTENTE', accion: { tipo: 'VINCULAR_TRANSACCION', transaccionId: 900n } });
    // ya reclamada, de otra cuenta, de otro monto o de otro día → se crea una nueva
    for (const otra of [{ vinculada: true }, { cuentaOrigenId: 1n }, { montoCop: d(50001) }, { fecha: new Date('2026-10-12T05:00:00Z') }]) {
      expect(planificar(cuentaItem(), snap({ transacciones: [{ ...manual, ...otra }] })).accion.tipo).toBe('CREAR_TRANSACCION');
    }
  });

  it('dos transferencias iguales con 17 minutos de diferencia son dos hechos distintos; con 2 minutos, un duplicado', () => {
    const s = snap();
    const a = planificar(cuentaItem({ externalMessageId: '<a>' }), s, { notificacionId: 1n });
    aplicarPlanASnapshot(s, a, { notificacionId: 1n, transaccionId: 900n }, new Date('2026-10-14T14:17:00Z'));
    expect(planificar(cuentaItem({ externalMessageId: '<b>', hora: '09:19:00' }), s, { notificacionId: 2n }).motivo).toBe('duplicado_de_correo');
    expect(planificar(cuentaItem({ externalMessageId: '<c>', hora: '09:34:00' }), s, { notificacionId: 3n }).motivo).toBe('transaccion_confirmada_automaticamente');
  });

  it('correos informativos, errores de parseo y tipos desconocidos', () => {
    expect(planificar(cuentaItem({ asunto: 'Tu producto se vence el 20' }), snap())).toMatchObject({ estado: 'IGNORADO', motivo: 'aviso_informativo_o_error_de_parseo' });
    expect(planificar(cuentaItem({ tipo: 'Desconocido', metodo: 'QR', comercio: '' }), snap())).toMatchObject({ estado: 'PENDIENTE', motivo: 'tipo_o_metodo_no_reconocido' });
    expect(planificar(cuentaItem({ valor: 'abc' }), snap())).toMatchObject({ estado: 'ERROR', motivo: 'monto_invalido' });
    expect(planificar(cuentaItem({ fecha: '2026-13-45' }), snap())).toMatchObject({ estado: 'ERROR', motivo: 'fecha_u_hora_invalida' });
  });
});

describe('plantilla — límites', () => {
  it('con una sola compra de muestra no hay plantilla', () => {
    const s = snap({ compras: [compra(1, { responsables: felipe100 })], notificaciones: [revisada(1, 1, 'didi food')] });
    expect(elegirPlantilla(s, 'didi food')).toBeNull();
    expect(elegirPlantilla(s, '')).toBeNull();
  });

  it('copia las cuotas del patrón (p. ej. 6 cuotas) y el interés de la compra más reciente', () => {
    const compras = [1, 2, 3].map((i) => compra(i, { cuotas: 6, interes: d('1.5'), concepto: 'TU Boleta', responsables: [{ personaId: 2n, porcentaje: d(50), cuotas: 6 }], fecha: `2026-0${i}-10` }));
    const plantilla = elegirPlantilla(snap({ compras, notificaciones: compras.map((c) => revisada(Number(c.id), Number(c.id), 'tu boleta')) }), 'tu boleta');
    expect(plantilla).toMatchObject({ numeroCuotas: 6, concepto: 'TU Boleta', muestras: 3 });
    expect(plantilla?.interes?.toString()).toBe('1.5');
    expect(plantilla?.responsables).toEqual([{ personaId: 2n, porcentaje: d(50), cuotas: 6 }]);
  });
});
