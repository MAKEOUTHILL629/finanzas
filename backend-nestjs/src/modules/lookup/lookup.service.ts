import { Injectable } from '@nestjs/common';
import { idNum, numOrNull } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizarTagSlug } from '../notificaciones-correo/comercio.util';
import { EstadoPlastico, TipoTarjeta, estadosDePlasticos } from '../tarjetas/tipos-tarjeta.util';

export const TIPOS_CATALOGO = ['personas', 'tarjetas', 'cuentas', 'categorias'] as const;
export type TipoCatalogo = (typeof TIPOS_CATALOGO)[number];

/** Una persona para un selector: `nombre` siempre es texto (nunca null) y `esPropia` marca a quien usa la app. */
export interface ItemPersona {
  id: number;
  nombre: string;
  iniciales: string | null;
  color: string | null;
  esPropia: boolean;
  /** Tiene una cuenta de usuario enlazada (es quien puede aprobar/rechazar sus préstamos). */
  tieneUsuario: boolean;
  email: string | null;
  celular: string | null;
}

export interface ItemPlasticoLookup {
  id: number;
  ultimos4: string;
  esActivo: boolean;
  vigenteDesde: string | null;
  vigenteHasta: string | null;
  /** ACTIVA · REEMPLAZADA · INACTIVA: sirve para agrupar «Activas» / «Históricas» en los selectores. */
  estado: EstadoPlastico;
}

export interface ItemTarjeta {
  id: number;
  /** CREDITO | DEBITO. Las compras a crédito, extractos y cupos solo admiten las de crédito. */
  tipo: TipoTarjeta;
  /** Cuenta a la que pertenece (obligatoria en débito). */
  cuentaId: number | null;
  /** Nombre corto («Débito *3698»). */
  alias: string | null;
  /** Producto «sin número» (recibe lo que el banco avisa sin los últimos 4). */
  esGenerica: boolean;
  /** «American Express · Green»: nunca vacío («Tarjeta #3» si no tiene nombre). */
  nombre: string;
  franquicia: string | null;
  descripcion: string | null;
  /** Plástico vigente: lo que se ofrece en las compras nuevas. */
  ultimos4Activo: string | null;
  /** «American Express ··1927». */
  etiqueta: string;
  plasticos: ItemPlasticoLookup[];
  tasaInteresCompra: number | null;
  diaCorte: number | null;
  diaLimitePago: number | null;
  cupoTotal: number | null;
  permiteDolares: boolean;
  /** Tarjeta prestada/de tercero (Fase 5): fuera del cupo propio. */
  esTitularExterno: boolean;
  titularPersonaId: number | null;
}

export interface ItemCuenta {
  id: number;
  nombre: string;
  tipoCuenta: string;
  bancoEntidad: string | null;
  ultimos4: string | null;
  moneda: string;
  saldoActual: number;
  activa: boolean;
  esPrincipal: boolean;
  /** Cuenta «sin número» que agrupa los avisos del banco que no traen cuenta. */
  esGenerica: boolean;
}

export interface ItemCategoria {
  id: number;
  nombre: string;
  tipo: string;
  color: string | null;
  icono: string | null;
  /** Las del sistema no se pueden editar. */
  delSistema: boolean;
}

export interface ItemTagCatalogo {
  slug: string;
  nombre: string;
  frecuencia: number;
  color: string;
}

export interface Catalogos {
  personas?: ItemPersona[];
  tarjetas?: ItemTarjeta[];
  cuentas?: ItemCuenta[];
  categorias?: ItemCategoria[];
}

const PALETA_TAGS: ReadonlyArray<string> = [
  '#007AFF',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#FF2D55',
  '#5856D6',
  '#00C7BE',
  '#FF3B30',
];

const TAGS_SUGERIDOS_BASE: ReadonlyArray<{ slug: string; nombre: string; color: string }> = [
  { slug: '#rappi', nombre: 'Rappi', color: '#FF3B30' },
  { slug: '#didi-food', nombre: 'DiDi Food', color: '#FF9500' },
  { slug: '#didi-rides', nombre: 'DiDi Rides', color: '#007AFF' },
  { slug: '#domicilios', nombre: 'Domicilios', color: '#FF9500' },
  { slug: '#transporte', nombre: 'Transporte', color: '#007AFF' },
  { slug: '#comida', nombre: 'Comida', color: '#34C759' },
  { slug: '#viajes', nombre: 'Viajes', color: '#5856D6' },
  { slug: '#ropa', nombre: 'Ropa', color: '#AF52DE' },
  { slug: '#suscripciones', nombre: 'Suscripciones', color: '#FF2D55' },
  { slug: '#mercado', nombre: 'Mercado', color: '#34C759' },
  { slug: '#hogar', nombre: 'Hogar', color: '#00C7BE' },
  { slug: '#recurrente', nombre: 'Recurrente', color: '#5856D6' },
];

export function colorSugeridoTag(slug: string): string {
  const predefinido = TAGS_SUGERIDOS_BASE.find((t) => t.slug === slug);
  if (predefinido) return predefinido.color;
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return PALETA_TAGS[hash % PALETA_TAGS.length];
}

export function nombreLegibleTag(slug: string): string {
  const predefinido = TAGS_SUGERIDOS_BASE.find((t) => t.slug === slug);
  if (predefinido) return predefinido.nombre;
  const sinHash = slug.replace(/^#+/, '').replace(/[-_]+/g, ' ').trim();
  if (!sinHash) return slug;
  return sinHash
    .split(' ')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

const dia = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** `?tipos=personas,cuentas` → lista validada y sin repetir; vacío = todos. Un tipo desconocido devuelve `null`. */
export function parseTipos(texto: string | undefined): TipoCatalogo[] | null {
  if (texto === undefined || texto.trim() === '') return [...TIPOS_CATALOGO];
  const pedidos = [...new Set(texto.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const validos = pedidos.filter((t): t is TipoCatalogo => (TIPOS_CATALOGO as readonly string[]).includes(t));
  return validos.length === pedidos.length ? validos : null;
}

/**
 * Catálogos ligeros para llenar los selectores de los formularios (personas, tarjetas, cuentas, categorías) en UNA sola llamada.
 * Misma forma para todos —`id` numérico y `nombre` texto—, solo las columnas necesarias, sin paginar y sin relaciones nulas que
 * rompan el mapeo en el cliente. Siempre filtrado por el usuario (Regla 5).
 */
@Injectable()
export class LookupService {
  constructor(private readonly prisma: PrismaService) {}

  async catalogos(ownerUserId: bigint, tipos: TipoCatalogo[]): Promise<Catalogos> {
    const [personas, tarjetas, cuentas, categorias] = await Promise.all([
      tipos.includes('personas') ? this.personas(ownerUserId) : undefined,
      tipos.includes('tarjetas') ? this.tarjetas(ownerUserId) : undefined,
      tipos.includes('cuentas') ? this.cuentas(ownerUserId) : undefined,
      tipos.includes('categorias') ? this.categorias(ownerUserId) : undefined,
    ]);
    return { ...(personas ? { personas } : {}), ...(tarjetas ? { tarjetas } : {}), ...(cuentas ? { cuentas } : {}), ...(categorias ? { categorias } : {}) };
  }

  async personas(ownerUserId: bigint): Promise<ItemPersona[]> {
    const filas = await this.prisma.personas.findMany({
      where: { owner_user_id: ownerUserId },
      select: { id: true, nombre: true, iniciales_nombre: true, color_representativo: true, linked_user_id: true, email: true, numero_celular: true },
      orderBy: [{ nombre: 'asc' }, { id: 'asc' }],
    });
    return filas.map((p) => ({
      id: idNum(p.id),
      nombre: p.nombre?.trim() || `Persona #${p.id}`,
      iniciales: p.iniciales_nombre,
      color: p.color_representativo,
      esPropia: p.linked_user_id !== null && p.linked_user_id === ownerUserId,
      tieneUsuario: p.linked_user_id !== null,
      email: p.email,
      celular: p.numero_celular,
    }));
  }

  async tarjetas(ownerUserId: bigint): Promise<ItemTarjeta[]> {
    const filas = await this.prisma.tarjetas.findMany({
      where: { owner_user_id: ownerUserId },
      select: {
        id: true,
        franquicia: true,
        descripcion: true,
        tasa_interes_compra: true,
        dia_corte: true,
        dia_limite_pago: true,
        cupo_total: true,
        permite_dolares: true,
        tipo_tarjeta: true,
        cuenta_id: true,
        alias: true,
        es_generica: true,
        es_titular_externo: true,
        titular_persona_id: true,
        plasticos: { select: { id: true, ultimos_4: true, es_activo: true, vigente_desde: true, vigente_hasta: true }, orderBy: { id: 'desc' } },
      },
      orderBy: { id: 'asc' },
    });
    return filas.map((t) => {
      const plasticos = [...t.plasticos].sort((a, b) => Number(b.es_activo) - Number(a.es_activo) || Number(b.id - a.id));
      const activo = plasticos.find((p) => p.es_activo)?.ultimos_4 ?? null;
      const nombre = [t.franquicia, t.descripcion].filter(Boolean).join(' · ') || `Tarjeta #${t.id}`;
      const estados = estadosDePlasticos(
        plasticos.map((p) => ({ id: idNum(p.id), esActivo: p.es_activo, vigenteDesde: dia(p.vigente_desde), vigenteHasta: dia(p.vigente_hasta) })),
      );
      return {
        id: idNum(t.id),
        tipo: t.tipo_tarjeta as TipoTarjeta,
        cuentaId: t.cuenta_id === null ? null : idNum(t.cuenta_id),
        alias: t.alias,
        esGenerica: t.es_generica,
        nombre,
        franquicia: t.franquicia,
        descripcion: t.descripcion,
        ultimos4Activo: activo,
        etiqueta: `${(t.es_generica ? t.alias : null) || t.franquicia || nombre}${activo ? ` ··${activo}` : ''}`,
        plasticos: plasticos.map((p) => ({
          id: idNum(p.id),
          ultimos4: p.ultimos_4,
          esActivo: p.es_activo,
          vigenteDesde: dia(p.vigente_desde),
          vigenteHasta: dia(p.vigente_hasta),
          estado: estados.get(idNum(p.id)) ?? 'INACTIVA',
        })),
        tasaInteresCompra: numOrNull(t.tasa_interes_compra),
        diaCorte: t.dia_corte,
        diaLimitePago: t.dia_limite_pago,
        cupoTotal: numOrNull(t.cupo_total),
        permiteDolares: t.permite_dolares === true,
        esTitularExterno: t.es_titular_externo === true,
        titularPersonaId: t.titular_persona_id === null ? null : idNum(t.titular_persona_id),
      };
    });
  }

  async cuentas(ownerUserId: bigint): Promise<ItemCuenta[]> {
    const filas = await this.prisma.cuentasFinancieras.findMany({
      where: { owner_user_id: ownerUserId },
      select: { id: true, nombre: true, tipo_cuenta: true, banco_entidad: true, ultimos_4_digitos: true, moneda: true, saldo_actual: true, is_active: true, es_principal: true, es_generica: true },
      orderBy: { id: 'asc' },
    });
    return filas.map((c) => ({
      id: idNum(c.id),
      nombre: c.nombre,
      tipoCuenta: c.tipo_cuenta,
      bancoEntidad: c.banco_entidad,
      ultimos4: c.ultimos_4_digitos,
      moneda: c.moneda,
      saldoActual: numOrNull(c.saldo_actual) ?? 0,
      activa: c.is_active !== false,
      esPrincipal: c.es_principal === true,
      esGenerica: c.es_generica === true,
    }));
  }

  /** Las del sistema (`owner_user_id` NULL) y las del usuario. */
  async categorias(ownerUserId: bigint): Promise<ItemCategoria[]> {
    const filas = await this.prisma.categorias.findMany({
      where: { OR: [{ owner_user_id: null }, { owner_user_id: ownerUserId }] },
      select: { id: true, nombre: true, tipo: true, color: true, icono: true, owner_user_id: true },
      orderBy: [{ nombre: 'asc' }, { id: 'asc' }],
    });
    return filas.map((c) => ({ id: idNum(c.id), nombre: c.nombre, tipo: c.tipo, color: c.color, icono: c.icono, delSistema: c.owner_user_id === null }));
  }

  /**
   * `GET /api/lookup/tags` — Catálogo de tags del usuario consolidando:
   *  1. Etiquetas personalizadas en `"Etiquetas"`
   *  2. Frecuencia real de uso en `"ComprasCredito"` y `"Transacciones"`
   *  3. Tags sugeridos base para autocompletado rápido
   */
  async tags(ownerUserId: bigint): Promise<ItemTagCatalogo[]> {
    const [etiquetas, compras, transacciones] = await Promise.all([
      this.prisma.etiquetas
        ? this.prisma.etiquetas.findMany({
            where: { owner_user_id: ownerUserId },
            select: { slug: true, nombre: true, color: true },
          })
        : Promise.resolve([]),
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId },
        select: { tags: true },
      }),
      this.prisma.transacciones.findMany({
        where: { owner_user_id: ownerUserId },
        select: { tags: true },
      }),
    ]);

    const mapa = new Map<string, ItemTagCatalogo>();

    for (const base of TAGS_SUGERIDOS_BASE) {
      mapa.set(base.slug, {
        slug: base.slug,
        nombre: base.nombre,
        frecuencia: 0,
        color: base.color,
      });
    }

    for (const et of etiquetas ?? []) {
      const slug = normalizarTagSlug(et.slug);
      if (!slug) continue;
      mapa.set(slug, {
        slug,
        nombre: et.nombre?.trim() || nombreLegibleTag(slug),
        frecuencia: mapa.get(slug)?.frecuencia ?? 0,
        color: et.color || colorSugeridoTag(slug),
      });
    }

    const acumular = (listaTags: string[] | null | undefined) => {
      for (const raw of listaTags ?? []) {
        const slug = normalizarTagSlug(raw);
        if (!slug) continue;
        const actual = mapa.get(slug);
        if (actual) {
          actual.frecuencia += 1;
        } else {
          mapa.set(slug, {
            slug,
            nombre: nombreLegibleTag(slug),
            frecuencia: 1,
            color: colorSugeridoTag(slug),
          });
        }
      }
    };

    for (const c of compras ?? []) acumular(c.tags);
    for (const t of transacciones ?? []) acumular(t.tags);

    return [...mapa.values()].sort((a, b) => b.frecuencia - a.frecuencia || a.slug.localeCompare(b.slug));
  }
}
