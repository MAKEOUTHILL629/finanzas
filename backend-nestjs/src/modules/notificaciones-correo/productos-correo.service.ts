import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TipoCuentaFinanciera } from '../../common/enums/finance.enums';
import { toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { resolverCuenta, resolverTarjeta, tokensDe4Digitos } from './bancolombia-normalizer.util';
import { AsignarProductoDto } from './dto/productos-correo.dto';

/** Evidencia mínima para asociar solos los últimos 4 dígitos de una tarjeta: compras que coinciden en fecha y monto. */
export const MIN_VOTOS_AUTO = 3;
export const MIN_CONFIANZA_AUTO = 0.75;

export interface AprendizajeTarjeta {
  ultimos4: string;
  tarjetaId: number;
  tarjeta: string;
  votos: number;
  total: number;
  aplicado: boolean;
}

export type SugerenciaProducto =
  | { tipo: 'TARJETA_EXISTENTE'; tarjetaId: number; tarjeta: string; votos: number; total: number; automatica: boolean }
  | { tipo: 'CREAR_TARJETA' }
  | { tipo: 'CREAR_CUENTA'; nombre: string; tipoCuenta: TipoCuentaFinanciera; esPrincipal: boolean }
  | { tipo: 'AGREGAR_A_CUENTA'; cuentaId: number; cuenta: string };

export interface ProductoDetectado {
  ultimos4: string;
  instrumento: 'TC' | 'CUENTA';
  esDebito: boolean;
  correos: number;
  pendientes: number;
  primera: Date | null;
  ultima: Date | null;
  totalCop: string;
  asignadoA: { tipo: 'TARJETA' | 'CUENTA'; id: number; nombre: string } | null;
  sugerencia: SugerenciaProducto | null;
}

interface FilaProducto {
  ultimos_4: string;
  instrumento: string | null;
  es_debito: boolean | null;
  correos: number;
  pendientes: number;
  primera: Date | null;
  ultima: Date | null;
  total_cop: Prisma.Decimal | null;
}
interface FilaVoto {
  u4: string;
  tarjeta_id: bigint;
  votos: number;
}

const nombreTarjeta = (t: { franquicia: string | null; descripcion: string | null; id: bigint }): string =>
  [t.franquicia, t.descripcion].filter(Boolean).join(' · ') || `Tarjeta ${t.id}`;

/** Agrega un grupo de 4 dígitos a la lista separada por comas, sin repetirlo. */
export function agregarUltimos4(actual: string | null | undefined, nuevo: string): string {
  const tokens = tokensDe4Digitos(actual);
  return (tokens.includes(nuevo) ? tokens : [...tokens, nuevo]).join(',');
}

/**
 * Productos que aparecen en los correos del banco (por los últimos 4 dígitos) y a qué cuenta o tarjeta pertenecen.
 * Permite poblar `Tarjetas.ultimos_4_digitos` / `CuentasFinancieras.ultimos_4_digitos` —de lo que ya se sabe— y asignar a mano lo demás.
 */
@Injectable()
export class ProductosCorreoService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── lectura ─────────────────────────────

  async listar(ownerUserId: bigint): Promise<ProductoDetectado[]> {
    const [filas, votos, cuentas, tarjetas] = await Promise.all([
      this.filasProductos(ownerUserId),
      this.votosPorTarjeta(ownerUserId),
      this.prisma.cuentasFinancieras.findMany({ where: { owner_user_id: ownerUserId }, orderBy: { id: 'asc' } }),
      this.prisma.tarjetas.findMany({ where: { owner_user_id: ownerUserId }, orderBy: { id: 'asc' } }),
    ]);

    const principal = cuentas.find((c) => c.es_principal && c.is_active !== false) ?? (cuentas.filter((c) => c.is_active !== false).length === 1 ? cuentas.find((c) => c.is_active !== false) : undefined);
    const noDebito = filas.filter((f) => f.instrumento !== 'TC' && !f.es_debito && !resolverCuenta(cuentas, f.ultimos_4));
    const candidataPrincipal = !cuentas.some((c) => c.es_principal) ? noDebito.slice().sort((a, b) => b.correos - a.correos)[0]?.ultimos_4 : undefined;

    return filas.map((f): ProductoDetectado => {
      const esTc = f.instrumento === 'TC';
      const tarjeta = esTc ? resolverTarjeta(tarjetas, f.ultimos_4) : null;
      const cuenta = !esTc ? resolverCuenta(cuentas, f.ultimos_4) : null;
      const asignadoA = tarjeta
        ? { tipo: 'TARJETA' as const, id: Number(tarjeta.id), nombre: nombreTarjeta(tarjeta) }
        : cuenta
          ? { tipo: 'CUENTA' as const, id: Number(cuenta.id), nombre: cuenta.nombre }
          : null;

      let sugerencia: SugerenciaProducto | null = null;
      if (!asignadoA) {
        if (esTc) {
          const propios = votos.filter((v) => v.u4 === f.ultimos_4).sort((a, b) => b.votos - a.votos);
          const total = propios.reduce((acc, v) => acc + v.votos, 0);
          const top = propios[0];
          const t = top ? tarjetas.find((x) => x.id === top.tarjeta_id) : undefined;
          sugerencia =
            top && t
              ? {
                  tipo: 'TARJETA_EXISTENTE',
                  tarjetaId: Number(t.id),
                  tarjeta: nombreTarjeta(t),
                  votos: top.votos,
                  total,
                  automatica: top.votos >= MIN_VOTOS_AUTO && top.votos / total >= MIN_CONFIANZA_AUTO,
                }
              : { tipo: 'CREAR_TARJETA' };
        } else if (f.es_debito) {
          sugerencia = principal ? { tipo: 'AGREGAR_A_CUENTA', cuentaId: Number(principal.id), cuenta: principal.nombre } : null;
        } else {
          sugerencia = {
            tipo: 'CREAR_CUENTA',
            nombre: `Bancolombia *${f.ultimos_4}`,
            tipoCuenta: TipoCuentaFinanciera.AHORROS,
            esPrincipal: candidataPrincipal === f.ultimos_4,
          };
        }
      }

      return {
        ultimos4: f.ultimos_4,
        instrumento: esTc ? 'TC' : 'CUENTA',
        esDebito: f.es_debito === true,
        correos: f.correos,
        pendientes: f.pendientes,
        primera: f.primera,
        ultima: f.ultima,
        totalCop: toDecimal(f.total_cop).toString(),
        asignadoA,
        sugerencia,
      };
    });
  }

  // ───────────────────────────── aprendizaje ─────────────────────────────

  /**
   * Deduce de qué tarjeta son unos últimos 4 dígitos mirando las compras que ya existen: cada correo cuya fecha y monto
   * coinciden con una compra de la tarjeta X «vota» por X. Con suficiente evidencia (≥3 votos y ≥75 %) se guarda sola.
   */
  async inferirTarjetas(ownerUserId: bigint, opciones: { aplicar: boolean }): Promise<AprendizajeTarjeta[]> {
    const [votos, tarjetas, cuentas] = await Promise.all([
      this.votosPorTarjeta(ownerUserId),
      this.prisma.tarjetas.findMany({ where: { owner_user_id: ownerUserId } }),
      this.prisma.cuentasFinancieras.findMany({ where: { owner_user_id: ownerUserId }, select: { id: true, ultimos_4_digitos: true } }),
    ]);
    const porU4 = new Map<string, FilaVoto[]>();
    for (const v of votos) porU4.set(v.u4, [...(porU4.get(v.u4) ?? []), v]);

    const resultado: AprendizajeTarjeta[] = [];
    for (const [u4, filas] of porU4) {
      if (resolverTarjeta(tarjetas, u4) || resolverCuenta(cuentas, u4)) continue; // ya asignado
      const total = filas.reduce((acc, f) => acc + f.votos, 0);
      const top = [...filas].sort((a, b) => b.votos - a.votos)[0];
      if (top.votos < MIN_VOTOS_AUTO || top.votos / total < MIN_CONFIANZA_AUTO) continue;
      const tarjeta = tarjetas.find((t) => t.id === top.tarjeta_id);
      if (!tarjeta) continue;
      if (opciones.aplicar) {
        await this.prisma.tarjetas.update({ where: { id: tarjeta.id }, data: { ultimos_4_digitos: agregarUltimos4(tarjeta.ultimos_4_digitos, u4) } });
        tarjeta.ultimos_4_digitos = agregarUltimos4(tarjeta.ultimos_4_digitos, u4);
      }
      resultado.push({ ultimos4: u4, tarjetaId: Number(tarjeta.id), tarjeta: nombreTarjeta(tarjeta), votos: top.votos, total, aplicado: opciones.aplicar });
    }
    return resultado;
  }

  // ───────────────────────────── asignación manual ─────────────────────────────

  async asignar(dto: AsignarProductoDto, ownerUserId: bigint) {
    const [tarjetas, cuentas] = await Promise.all([
      this.prisma.tarjetas.findMany({ where: { owner_user_id: ownerUserId } }),
      this.prisma.cuentasFinancieras.findMany({ where: { owner_user_id: ownerUserId } }),
    ]);
    const yaTarjeta = resolverTarjeta(tarjetas, dto.ultimos4);
    const yaCuenta = resolverCuenta(cuentas, dto.ultimos4);
    const ocupante = yaTarjeta ? nombreTarjeta(yaTarjeta) : yaCuenta ? yaCuenta.nombre : null;
    const mismoDestino = dto.id !== undefined && ((dto.destino === 'TARJETA' && yaTarjeta?.id === BigInt(dto.id)) || (dto.destino === 'CUENTA' && yaCuenta?.id === BigInt(dto.id)));
    if (ocupante && !mismoDestino) {
      throw new ConflictException(`Los dígitos ${dto.ultimos4} ya pertenecen a "${ocupante}". Quítalos de ahí antes de asignarlos a otro producto.`);
    }
    if ((dto.id === undefined) === (dto.nuevo === undefined)) {
      throw datosInvalidos({ id: ['Indica el producto existente (id) o los datos del nuevo (nuevo), pero no ambos'] });
    }

    if (dto.destino === 'TARJETA') {
      if (dto.id !== undefined) {
        const t = tarjetas.find((x) => x.id === BigInt(dto.id as number));
        if (!t) throw new NotFoundException(`Tarjeta ${dto.id} no encontrada`);
        const g = await this.prisma.tarjetas.update({ where: { id: t.id }, data: { ultimos_4_digitos: agregarUltimos4(t.ultimos_4_digitos, dto.ultimos4) } });
        return { ultimos4: dto.ultimos4, destino: 'TARJETA' as const, id: Number(g.id), nombre: nombreTarjeta(g), creado: false };
      }
      const n = dto.nuevo as NonNullable<AsignarProductoDto['nuevo']>;
      const g = await this.prisma.tarjetas.create({
        data: { owner_user_id: ownerUserId, franquicia: n.franquicia?.trim() || 'Tarjeta de crédito', descripcion: n.descripcion?.trim() || null, ultimos_4_digitos: dto.ultimos4 },
      });
      return { ultimos4: dto.ultimos4, destino: 'TARJETA' as const, id: Number(g.id), nombre: nombreTarjeta(g), creado: true };
    }

    // CUENTA
    if (dto.id !== undefined) {
      const c = cuentas.find((x) => x.id === BigInt(dto.id as number));
      if (!c) throw new NotFoundException(`Cuenta ${dto.id} no encontrada`);
      const g = await this.prisma.cuentasFinancieras.update({ where: { id: c.id }, data: { ultimos_4_digitos: agregarUltimos4(c.ultimos_4_digitos, dto.ultimos4) } });
      return { ultimos4: dto.ultimos4, destino: 'CUENTA' as const, id: Number(g.id), nombre: g.nombre, creado: false };
    }
    const n = dto.nuevo as NonNullable<AsignarProductoDto['nuevo']>;
    const g = await this.prisma.$transaction(async (tx) => {
      if (n.esPrincipal) await tx.cuentasFinancieras.updateMany({ where: { owner_user_id: ownerUserId, es_principal: true }, data: { es_principal: false } });
      return tx.cuentasFinancieras.create({
        data: {
          owner_user_id: ownerUserId,
          nombre: n.nombre?.trim() || `Bancolombia *${dto.ultimos4}`,
          tipo_cuenta: n.tipoCuenta ?? TipoCuentaFinanciera.AHORROS,
          banco_entidad: n.bancoEntidad?.trim() || 'Bancolombia',
          ultimos_4_digitos: dto.ultimos4,
          moneda: 'COP',
          saldo_actual: toDbMoney(toDecimal(n.saldoInicial ?? 0)),
          is_active: true,
          es_principal: n.esPrincipal === true,
        },
      });
    });
    return { ultimos4: dto.ultimos4, destino: 'CUENTA' as const, id: Number(g.id), nombre: g.nombre, creado: true };
  }

  /**
   * Acepta de una vez las sugerencias de `listar` (todas, o solo las de los `ultimos4` indicados): asocia las tarjetas por
   * evidencia, crea las cuentas detectadas y agrega las tarjetas débito a la cuenta principal.
   */
  async aceptarSugerencias(ownerUserId: bigint, ultimos4?: string[]) {
    const productos = (await this.listar(ownerUserId)).filter((p) => !ultimos4 || ultimos4.includes(p.ultimos4));
    const hechos: Array<Awaited<ReturnType<ProductosCorreoService['asignar']>>> = [];
    const omitidos: Array<{ ultimos4: string; motivo: string }> = [];

    const orden = (p: ProductoDetectado) => (p.sugerencia?.tipo === 'CREAR_CUENTA' ? (p.sugerencia.esPrincipal ? 0 : 1) : p.sugerencia?.tipo === 'AGREGAR_A_CUENTA' ? 3 : 2);
    let principalId: number | null = null;
    for (const p of productos.filter((x) => x.sugerencia).sort((a, b) => orden(a) - orden(b))) {
      const s = p.sugerencia as SugerenciaProducto;
      try {
        if (s.tipo === 'TARJETA_EXISTENTE' && s.automatica) {
          hechos.push(await this.asignar({ ultimos4: p.ultimos4, destino: 'TARJETA', id: s.tarjetaId }, ownerUserId));
        } else if (s.tipo === 'CREAR_CUENTA') {
          const r = await this.asignar({ ultimos4: p.ultimos4, destino: 'CUENTA', nuevo: { nombre: s.nombre, tipoCuenta: s.tipoCuenta, esPrincipal: s.esPrincipal } }, ownerUserId);
          if (s.esPrincipal) principalId = r.id;
          hechos.push(r);
        } else if (s.tipo === 'AGREGAR_A_CUENTA' || (p.esDebito && principalId !== null)) {
          const cuentaId = s.tipo === 'AGREGAR_A_CUENTA' ? s.cuentaId : (principalId as number);
          hechos.push(await this.asignar({ ultimos4: p.ultimos4, destino: 'CUENTA', id: cuentaId }, ownerUserId));
        } else {
          omitidos.push({ ultimos4: p.ultimos4, motivo: s.tipo === 'TARJETA_EXISTENTE' ? 'evidencia_insuficiente' : 'requiere_decision_manual' });
        }
      } catch (e) {
        omitidos.push({ ultimos4: p.ultimos4, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
    // Tarjetas débito detectadas antes de existir la cuenta principal.
    for (const p of productos.filter((x) => x.esDebito && !x.asignadoA && !hechos.some((h) => h.ultimos4 === x.ultimos4))) {
      if (principalId === null) {
        omitidos.push({ ultimos4: p.ultimos4, motivo: 'sin_cuenta_principal' });
        continue;
      }
      hechos.push(await this.asignar({ ultimos4: p.ultimos4, destino: 'CUENTA', id: principalId }, ownerUserId));
    }
    return { aplicados: hechos, omitidos: omitidos.filter((o, i, a) => a.findIndex((x) => x.ultimos4 === o.ultimos4) === i && !hechos.some((h) => h.ultimos4 === o.ultimos4)) };
  }

  // ───────────────────────────── consultas ─────────────────────────────

  private filasProductos(ownerUserId: bigint): Promise<FilaProducto[]> {
    return this.prisma.$queryRaw<FilaProducto[]>`
      SELECT n.ultimos_4,
             n.datos_parseados->>'instrumento' AS instrumento,
             bool_or(n.datos_parseados->>'metodo' = 'Tarjeta Debito' OR n.datos_parseados->>'origenRaw' ~* 't[.]?[[:space:]]*deb') AS es_debito,
             count(*)::int AS correos,
             (count(*) FILTER (WHERE n.estado_procesamiento = 'PENDIENTE'))::int AS pendientes,
             min(n.fecha_correo) AS primera,
             max(n.fecha_correo) AS ultima,
             sum(n.monto_original) FILTER (WHERE n.moneda = 'COP') AS total_cop
      FROM "NotificacionesCorreo" n
      WHERE n.owner_user_id = ${ownerUserId}::int8 AND n.ultimos_4 IS NOT NULL
      GROUP BY n.ultimos_4, n.datos_parseados->>'instrumento'
      ORDER BY count(*) DESC, n.ultimos_4`;
  }

  /** Por cada (últimos 4, tarjeta): cuántos correos de compra coinciden en fecha y monto con una compra de esa tarjeta. */
  private votosPorTarjeta(ownerUserId: bigint): Promise<FilaVoto[]> {
    return this.prisma.$queryRaw<FilaVoto[]>`
      SELECT n.ultimos_4 AS u4, c.tarjeta AS tarjeta_id, count(*)::int AS votos
      FROM "NotificacionesCorreo" n
      JOIN "ComprasCredito" c
        ON c.owner_user_id = n.owner_user_id
       AND c.tarjeta IS NOT NULL
       AND c.fecha_compra = (n.fecha_correo AT TIME ZONE 'America/Bogota')::date
       AND ((n.moneda = 'COP' AND c.moneda_original = 'COP' AND c.valor_compra = n.monto_original)
         OR (n.moneda = 'USD' AND c.moneda_original = 'USD' AND c.valor_moneda_original = n.monto_original))
      WHERE n.owner_user_id = ${ownerUserId}::int8
        AND n.ultimos_4 IS NOT NULL
        AND n.datos_parseados->>'instrumento' = 'TC'
        AND n.datos_parseados->>'ruta' = 'COMPRA_TC'
      GROUP BY n.ultimos_4, c.tarjeta`;
  }
}
