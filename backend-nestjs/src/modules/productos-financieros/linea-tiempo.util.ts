/**
 * Lógica PURA de la línea de tiempo de productos financieros (tarjetas y cuentas): une lo que dicen los plásticos y las cuentas
 * (vigencias) con cuánto se usó cada uno (compras, transacciones y avisos del banco). Sin base de datos.
 */
import { EstadoPlastico, TipoTarjeta, estadosDePlasticos } from '../tarjetas/tipos-tarjeta.util';

export type TipoProducto = TipoTarjeta | 'CUENTA';

export interface Uso {
  n: number;
  /** Suma en COP (los avisos en otra moneda no suman). */
  monto: number;
  /** `yyyy-MM-dd` */
  primera: string | null;
  ultima: string | null;
}

export const SIN_USO: Uso = { n: 0, monto: 0, primera: null, ultima: null };

export interface PlasticoEntrada {
  id: number;
  tarjetaId: number;
  ultimos4: string;
  esActivo: boolean;
  vigenteDesde: string | null;
  vigenteHasta: string | null;
  reemplazaAId: number | null;
  tipo: TipoTarjeta;
  franquicia: string | null;
  alias: string | null;
  cuentaId: number | null;
}

export interface LineaGenericaEntrada {
  id: number;
  franquicia: string | null;
  alias: string | null;
}

export interface CuentaEntrada {
  id: number;
  nombre: string;
  bancoEntidad: string | null;
  ultimos4: string | null;
  activa: boolean;
  esGenerica: boolean;
  inicioUso: string | null;
  finUso: string | null;
}

export interface UsosEntrada {
  /** Compras a crédito por plástico (el guardado o el deducido por fecha). */
  comprasPorPlastico: Map<number, Uso>;
  /** Compras de una línea sin plásticos (la tarjeta «sin número»). */
  comprasPorLinea: Map<number, Uso>;
  /** Avisos del banco por últimos 4 y tipo de producto (`''` = sin números). */
  avisos: Map<string, Uso>;
  /** Transacciones por cuenta. */
  transaccionesPorCuenta: Map<number, Uso>;
}

export interface ProductoLineaTiempo {
  clave: string;
  tipo: TipoProducto;
  etiqueta: string;
  detalle: string;
  ultimos4: string | null;
  estado: EstadoPlastico;
  generica: boolean;
  /** `yyyy-MM-dd`: inicio del uso (la vigencia registrada o, si no la hay, el primer movimiento). */
  desde: string | null;
  /** `null` = sigue en uso. */
  hasta: string | null;
  /** Cuántos movimientos tiene y de dónde sale la cifra (la fuente con más registros). */
  movimientos: number;
  monto: number;
  fuente: 'REGISTROS' | 'AVISOS' | 'NINGUNA';
  compras: number;
  transacciones: number;
  avisos: number;
  primerUso: string | null;
  ultimoUso: string | null;
  tarjetaId: number | null;
  plasticoId: number | null;
  cuentaId: number | null;
}

export const claveAviso = (ultimos4: string | null, tipo: 'TC' | 'CUENTA'): string => `${tipo}:${ultimos4 ?? ''}`;

const menor = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a <= b ? a : b);
const mayor = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a >= b ? a : b);

/** Combina los usos de dos fuentes sin repetir lo que ya cuenta la de más registros. */
function resumirUsos(registros: Uso, avisos: Uso): Pick<ProductoLineaTiempo, 'movimientos' | 'monto' | 'fuente' | 'primerUso' | 'ultimoUso'> {
  const fuente = registros.n === 0 && avisos.n === 0 ? 'NINGUNA' : registros.n >= avisos.n ? 'REGISTROS' : 'AVISOS';
  const base = fuente === 'AVISOS' ? avisos : registros;
  return {
    movimientos: base.n,
    monto: base.monto,
    fuente,
    primerUso: menor(registros.primera, avisos.primera),
    ultimoUso: mayor(registros.ultima, avisos.ultima),
  };
}

const nombreTipo = (tipo: TipoTarjeta) => (tipo === 'DEBITO' ? 'Débito' : 'Crédito');

export interface LineaTiempo {
  /** `yyyy-MM-dd` del inicio de la escala (el primer producto) y del final (hoy). */
  desde: string;
  hasta: string;
  productos: ProductoLineaTiempo[];
  totales: { productos: number; activos: number; movimientos: number; monto: number };
}

/** Arma la línea de tiempo: un renglón por plástico, por cuenta y por producto «sin número», ordenado por inicio de uso. */
export function construirLineaTiempo(entrada: {
  plasticos: PlasticoEntrada[];
  lineasGenericas: LineaGenericaEntrada[];
  cuentas: CuentaEntrada[];
  usos: UsosEntrada;
  hoy: string;
}): LineaTiempo {
  const { usos } = entrada;
  const productos: ProductoLineaTiempo[] = [];

  const estados = new Map<number, EstadoPlastico>();
  const porLinea = new Map<number, PlasticoEntrada[]>();
  for (const p of entrada.plasticos) porLinea.set(p.tarjetaId, [...(porLinea.get(p.tarjetaId) ?? []), p]);
  for (const hermanos of porLinea.values()) {
    for (const [id, estado] of estadosDePlasticos(hermanos.map((h) => ({ id: h.id, esActivo: h.esActivo, vigenteDesde: h.vigenteDesde, vigenteHasta: h.vigenteHasta, reemplazaAId: h.reemplazaAId }))))
      estados.set(id, estado);
  }

  for (const p of entrada.plasticos) {
    const registros = p.tipo === 'CREDITO' ? (usos.comprasPorPlastico.get(p.id) ?? SIN_USO) : SIN_USO;
    const avisos = usos.avisos.get(claveAviso(p.ultimos4, p.tipo === 'CREDITO' ? 'TC' : 'CUENTA')) ?? SIN_USO;
    const resumen = resumirUsos(registros, avisos);
    const estado = estados.get(p.id) ?? 'INACTIVA';
    productos.push({
      clave: `plastico:${p.id}`,
      tipo: p.tipo,
      etiqueta: `${nombreTipo(p.tipo)} *${p.ultimos4}`,
      detalle: [p.franquicia, p.alias && p.alias !== p.franquicia ? p.alias : null].filter(Boolean).join(' · ') || nombreTipo(p.tipo),
      ultimos4: p.ultimos4,
      estado,
      generica: false,
      desde: p.vigenteDesde ?? resumen.primerUso,
      hasta: p.esActivo ? null : (p.vigenteHasta ?? resumen.ultimoUso),
      ...resumen,
      compras: registros.n,
      transacciones: 0,
      avisos: avisos.n,
      tarjetaId: p.tarjetaId,
      plasticoId: p.id,
      cuentaId: p.cuentaId,
    });
  }

  for (const l of entrada.lineasGenericas) {
    const registros = usos.comprasPorLinea.get(l.id) ?? SIN_USO;
    const avisos = usos.avisos.get(claveAviso(null, 'TC')) ?? SIN_USO;
    const resumen = resumirUsos(registros, avisos);
    productos.push({
      clave: `tarjeta:${l.id}`,
      tipo: 'CREDITO',
      etiqueta: 'Crédito (sin número)',
      detalle: l.alias ?? l.franquicia ?? 'Tarjeta de crédito',
      ultimos4: null,
      estado: 'ACTIVA',
      generica: true,
      desde: resumen.primerUso,
      hasta: null,
      ...resumen,
      compras: registros.n,
      transacciones: 0,
      avisos: avisos.n,
      tarjetaId: l.id,
      plasticoId: null,
      cuentaId: null,
    });
  }

  for (const c of entrada.cuentas) {
    const registros = usos.transaccionesPorCuenta.get(c.id) ?? SIN_USO;
    const tokens = c.ultimos4 ? [...c.ultimos4.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]) : [];
    const avisos = (c.esGenerica ? [claveAviso(null, 'CUENTA')] : tokens.map((t) => claveAviso(t, 'CUENTA')))
      .map((k) => usos.avisos.get(k) ?? SIN_USO)
      .reduce<Uso>((acc, u) => ({ n: acc.n + u.n, monto: acc.monto + u.monto, primera: menor(acc.primera, u.primera), ultima: mayor(acc.ultima, u.ultima) }), SIN_USO);
    const resumen = resumirUsos(registros, avisos);
    const termino = c.finUso ?? (c.activa ? null : resumen.ultimoUso);
    productos.push({
      clave: `cuenta:${c.id}`,
      tipo: 'CUENTA',
      etiqueta: c.esGenerica ? 'Cuenta (sin número)' : tokens.length > 0 ? `Cuenta *${tokens[0]}` : c.nombre,
      detalle: [c.nombre, c.bancoEntidad].filter(Boolean).join(' · '),
      ultimos4: tokens[0] ?? null,
      estado: c.activa && !c.finUso ? 'ACTIVA' : 'INACTIVA',
      generica: c.esGenerica,
      desde: c.inicioUso ?? resumen.primerUso,
      hasta: termino,
      ...resumen,
      compras: 0,
      transacciones: registros.n,
      avisos: avisos.n,
      tarjetaId: null,
      plasticoId: null,
      cuentaId: c.id,
    });
  }

  const ordenTipo: Record<TipoProducto, number> = { CREDITO: 0, DEBITO: 1, CUENTA: 2 };
  productos.sort((a, b) => (a.desde ?? '9999-12-31').localeCompare(b.desde ?? '9999-12-31') || ordenTipo[a.tipo] - ordenTipo[b.tipo] || a.etiqueta.localeCompare(b.etiqueta));

  const inicios = productos.map((p) => p.desde).filter((d): d is string => d !== null);
  const desde = inicios.reduce<string>((acc, d) => (d < acc ? d : acc), entrada.hoy);
  return {
    desde,
    hasta: entrada.hoy,
    productos,
    totales: {
      productos: productos.length,
      activos: productos.filter((p) => p.estado === 'ACTIVA').length,
      movimientos: productos.reduce((s, p) => s + p.movimientos, 0),
      monto: productos.reduce((s, p) => s + p.monto, 0),
    },
  };
}
