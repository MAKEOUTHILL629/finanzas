/**
 * Lectura del CUERPO de los correos de Bancolombia para los casos que el Apps Script no clasifica
 * (tipo «Desconocido»): transferencias recibidas, compras rechazadas, avisos de inscripción, avances a una cuenta…
 * Funciones puras: sin BD ni Nest. Los patrones ignoran tildes, mayúsculas y espacios repetidos.
 */

const plano = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface TransferenciaRecibida {
  contraparte: string | null;
  monto: string | null;
  cuenta4: string | null;
  llave: string | null;
}

export interface TransferenciaEnviada {
  contraparte: string | null;
  monto: string | null;
  cuenta4: string | null;
  llave: string | null;
}

export interface AvanceTarjeta {
  monto: string | null;
  tarjeta4: string | null;
  cuentaDestino4: string | null;
}

export interface InterpretacionCuerpo {
  /** «tu compra … no fue exitosa por fondos insuficientes»: no es un gasto. */
  rechazada: boolean;
  /** «recibimos el pago de tu tarjeta…»: es un abono a tarjeta, nunca una compra (Fase 1). */
  pagoTarjeta: boolean;
  /** Avisos de inscripción / clave dinámica: no mueven dinero. */
  informativo: boolean;
  recibida: TransferenciaRecibida | null;
  enviada: TransferenciaEnviada | null;
  avance: AvanceTarjeta | null;
  /** «en tu cuenta de Ahorros» sin número: el banco no dice cuál. */
  cuentaSinNumero: boolean;
  /** Primeros 4 dígitos útiles que el cuerpo revela (cuenta o tarjeta), si el origen no los trajo. */
  ultimos4: string | null;
}

const VACIA: InterpretacionCuerpo = {
  rechazada: false,
  pagoTarjeta: false,
  informativo: false,
  recibida: null,
  enviada: null,
  avance: null,
  cuentaSinNumero: false,
  ultimos4: null,
};

const NOMBRE = String.raw`([A-Za-z][A-Za-z .'&-]{1,80}?)`;
const MONTO = String.raw`\$?\s*([\d][\d.,]*)`;

/** Quita la puntuación final que se cuela al capturar nombres ("LUIS HERNANDEZ,"). */
const limpiarNombre = (n: string | undefined): string | null => {
  const t = (n ?? '').replace(/[.,;:\s]+$/, '').trim();
  return t.length >= 3 ? t : null;
};

export function interpretarCuerpo(cuerpo: string | null | undefined): InterpretacionCuerpo {
  if (!cuerpo || !cuerpo.trim()) return VACIA;
  const t = plano(cuerpo);

  // Regex ampliada de la Fase 1 (texto ya sin tildes): declinada, fallida, cupo insuficiente, bloqueada…
  const rechazada =
    /no fue exitosa|no se pudo realizar|rechazad[ao]|declinad[ao]|transaccion fallida|fondos insuficientes|cupo insuficiente|intento de compra|bloquead[ao]|cancelad[ao] por el comercio/i.test(t);
  const pagoTarjeta =
    /pago (exitoso )?(a|de) (tu )?tarjeta|abono a tarjeta|recibimos (el|tu) pago de tu tarjeta|pago de extracto|pago minimo|pago total de tu tarjeta|comprobante de pago tarjeta/i.test(t);
  const informativo = /notificacion informativa/i.test(t) && /(inscripcion|clave dinamica)/i.test(t);

  let recibida: TransferenciaRecibida | null = null;
  if (/recibiste una transferencia/i.test(t)) {
    // «… transferencia de NOMBRE por $X en tu cuenta *4248 conectada a la llave @x …»
    const a = new RegExp(String.raw`recibiste una transferencia de ${NOMBRE} por ${MONTO}`, 'i').exec(t);
    // «… transferencia por $X de NOMBRE en tu cuenta **3698, …»
    const b = new RegExp(String.raw`recibiste una transferencia por ${MONTO} de ${NOMBRE} en tu cuenta`, 'i').exec(t);
    const cuenta = /en tu cuenta\s*\*{0,2}\s*(\d{4})(?!\d)/i.exec(t);
    const llave = /conectada a la llave\s+(\S+)/i.exec(t);
    recibida = {
      contraparte: limpiarNombre(a ? a[1] : b?.[2]),
      monto: (a ? a[2] : b?.[1]) ?? null,
      cuenta4: cuenta ? cuenta[1] : null,
      llave: llave ? llave[1].replace(/[.,;]+$/, '') : null,
    };
  }

  let enviada: TransferenciaEnviada | null = null;
  const env = new RegExp(
    String.raw`transferiste ${MONTO} a la llave\s+(\S+)\s+desde tu cuenta\s*\*{0,2}\s*(\d{4})(?!\d)\s+a ${NOMBRE}\s+el\s+\d`,
    'i',
  ).exec(t);
  if (env) {
    enviada = { monto: env[1], llave: env[2].replace(/[.,;]+$/, ''), cuenta4: env[3], contraparte: limpiarNombre(env[4]) };
  }

  let avance: AvanceTarjeta | null = null;
  const av = new RegExp(
    String.raw`avance por ${MONTO}.*?t\.?\s*cred\w*\s*\*?\s*(\d{4})(?!\d).*?(?:cta|cuenta)\s*\*?\s*(\d{4})(?!\d)`,
    'i',
  ).exec(t);
  if (av) avance = { monto: av[1], tarjeta4: av[2], cuentaDestino4: av[3] };

  const cuentaSinNumero = /en tu cuenta de ahorro/i.test(t) && !/en tu cuenta\s*\*?\s*\d{4}/i.test(t);
  const ultimos4 = recibida?.cuenta4 ?? enviada?.cuenta4 ?? avance?.tarjeta4 ?? null;

  return { rechazada, pagoTarjeta, informativo, recibida, enviada, avance, cuentaSinNumero, ultimos4 };
}
