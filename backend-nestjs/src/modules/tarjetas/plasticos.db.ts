import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, TarjetaPlasticos } from '@prisma/client';
import { formatIsoDate, truncateToDay } from '../../common/utils/date.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { cadenaUltimos4, cierreDelAnterior, MotivoReemplazo, PlasticoBase, plasticoParaFecha, tokensUltimos4 } from './plasticos.util';

type Db = Prisma.TransactionClient;

/** Fila de BD → forma que entiende la lógica pura. */
export const aBase = (p: TarjetaPlasticos): PlasticoBase & { fila: TarjetaPlasticos } => ({
  id: p.id,
  ultimos4: p.ultimos_4,
  esActivo: p.es_activo,
  vigenteDesde: p.vigente_desde,
  vigenteHasta: p.vigente_hasta,
  fila: p,
});

export async function plasticosDeTarjeta(db: Db, tarjetaId: bigint): Promise<TarjetaPlasticos[]> {
  return db.tarjetaPlasticos.findMany({ where: { tarjeta_id: tarjetaId }, orderBy: { id: 'asc' } });
}

/**
 * Deja `Tarjetas.ultimos_4_digitos` (lo que lee el parser de correos) como la lista de TODOS los plásticos, el activo primero.
 * Si la tarjeta no tiene plásticos NO la toca (conserva lo que hubiera).
 */
export async function sincronizarCadena(db: Db, tarjetaId: bigint): Promise<string | null> {
  const plasticos = await plasticosDeTarjeta(db, tarjetaId);
  if (plasticos.length === 0) return null;
  const cadena = cadenaUltimos4(plasticos.map((p) => ({ ultimos4: p.ultimos_4, esActivo: p.es_activo, orden: Number(p.id) })));
  await db.tarjetas.update({ where: { id: tarjetaId }, data: { ultimos_4_digitos: cadena } });
  return cadena;
}

/** ¿Estos 4 dígitos ya identifican a OTRA tarjeta o a una cuenta del usuario? Devuelve su nombre (o `null` si están libres). */
export async function ocupanteDeUltimos4(db: Db, ownerUserId: bigint, ultimos4: string, exceptoTarjetaId?: bigint): Promise<string | null> {
  const [tarjetas, cuentas] = await Promise.all([
    db.tarjetas.findMany({ where: { owner_user_id: ownerUserId, ...(exceptoTarjetaId ? { NOT: { id: exceptoTarjetaId } } : {}) }, select: { id: true, franquicia: true, descripcion: true, ultimos_4_digitos: true } }),
    db.cuentasFinancieras.findMany({ where: { owner_user_id: ownerUserId }, select: { nombre: true, ultimos_4_digitos: true } }),
  ]);
  const t = tarjetas.find((x) => tokensUltimos4(x.ultimos_4_digitos).includes(ultimos4));
  if (t) return [t.franquicia, t.descripcion].filter(Boolean).join(' · ') || `Tarjeta ${t.id}`;
  const c = cuentas.find((x) => tokensUltimos4(x.ultimos_4_digitos).includes(ultimos4));
  return c ? c.nombre : null;
}

/** Primer y último día (Bogotá) en que el banco avisó con estos 4 dígitos; `null` si nunca. */
async function evidenciaDeUltimos4(db: Db, ownerUserId: bigint, ultimos4: string): Promise<{ primera: Date; ultima: Date } | null> {
  const filas = await db.$queryRaw<Array<{ primera: Date | null; ultima: Date | null }>>`
    SELECT min((fecha_correo AT TIME ZONE 'America/Bogota')::date) AS primera,
           max((fecha_correo AT TIME ZONE 'America/Bogota')::date) AS ultima
    FROM "NotificacionesCorreo"
    WHERE owner_user_id = ${ownerUserId}::int8 AND ultimos_4 = ${ultimos4}`;
  const f = filas[0];
  return f?.primera && f.ultima ? { primera: truncateToDay(f.primera), ultima: truncateToDay(f.ultima) } : null;
}

/**
 * Registra los 4 dígitos como plástico de la tarjeta si aún no lo son (lo usa la asignación de productos de los correos y la edición
 * clásica de `ultimos4Digitos`). Sin plásticos previos queda activo. Con otros plásticos, el nuevo solo pasa a ser el ACTIVO si los
 * avisos del banco demuestran que es más reciente que el activo actual; si no, entra archivado (es un plástico anterior).
 */
export async function asegurarPlastico(db: Db, tarjeta: { id: bigint; owner_user_id: bigint | null }, ultimos4: string): Promise<TarjetaPlasticos> {
  const existentes = await plasticosDeTarjeta(db, tarjeta.id);
  const ya = existentes.find((p) => p.ultimos_4 === ultimos4);
  if (ya) {
    // El plástico ya estaba registrado, pero la lista de dígitos de la tarjeta (la que lee el parser de correos) puede no incluirlo:
    // sin esto «asignar» no tenía efecto y la sugerencia volvía a aparecer.
    await sincronizarCadena(db, tarjeta.id);
    return ya;
  }

  const activo = existentes.find((p) => p.es_activo);
  let creado: TarjetaPlasticos;
  if (existentes.length === 0 || !activo) {
    creado = await db.tarjetaPlasticos.create({ data: { tarjeta_id: tarjeta.id, owner_user_id: tarjeta.owner_user_id, ultimos_4: ultimos4, es_activo: true } });
  } else {
    const dueno = tarjeta.owner_user_id;
    const [nueva, vigente] = dueno === null ? [null, null] : await Promise.all([evidenciaDeUltimos4(db, dueno, ultimos4), evidenciaDeUltimos4(db, dueno, activo.ultimos_4)]);
    const esMasReciente = nueva !== null && (vigente === null || nueva.ultima.getTime() > vigente.ultima.getTime());
    if (esMasReciente && nueva) {
      // El anterior cierra con su último aviso si éste cae antes de la víspera del nuevo (y no antes de su propio inicio).
      const victima = cierreDelAnterior(activo.vigente_desde, nueva.primera);
      const ultimoAviso = vigente !== null && vigente.ultima.getTime() < victima.getTime() && (!activo.vigente_desde || vigente.ultima.getTime() >= activo.vigente_desde.getTime());
      await db.tarjetaPlasticos.update({ where: { id: activo.id }, data: { es_activo: false, vigente_hasta: ultimoAviso && vigente ? vigente.ultima : victima } });
      creado = await db.tarjetaPlasticos.create({
        data: { tarjeta_id: tarjeta.id, owner_user_id: dueno, ultimos_4: ultimos4, es_activo: true, vigente_desde: nueva.primera, reemplaza_a_id: activo.id, notas: 'Fechas deducidas de los avisos del banco.' },
      });
    } else {
      creado = await db.tarjetaPlasticos.create({
        data: { tarjeta_id: tarjeta.id, owner_user_id: dueno, ultimos_4: ultimos4, es_activo: false, vigente_hasta: nueva?.ultima ?? null, notas: nueva ? 'Fechas deducidas de los avisos del banco.' : null },
      });
    }
  }
  await sincronizarCadena(db, tarjeta.id);
  return creado;
}

export interface OpcionesPlasticoCompra {
  /** Elegido por el usuario: debe ser de esa tarjeta. */
  plasticoId?: number | bigint | null;
  /** Los 4 dígitos que trae el aviso del banco. */
  ultimos4?: string | null;
  /** Fecha de la compra: sin los dos anteriores se usa el plástico vigente ese día. */
  fecha?: Date | null;
}

/**
 * Plástico que se guarda en una compra nueva: el elegido (validado), el que coincide con los 4 dígitos del aviso o el vigente en la
 * fecha de la compra. `null` si la tarjeta no tiene plásticos registrados.
 */
export async function resolverPlasticoCompra(db: Db, ownerUserId: bigint, tarjetaId: bigint, op: OpcionesPlasticoCompra): Promise<bigint | null> {
  if (op.plasticoId !== undefined && op.plasticoId !== null) {
    const p = await db.tarjetaPlasticos.findFirst({ where: { id: BigInt(op.plasticoId), tarjeta_id: tarjetaId, tarjeta: { owner_user_id: ownerUserId } }, select: { id: true } });
    if (!p) throw datosInvalidos({ plasticoId: ['El plástico no existe o no pertenece a esa tarjeta'] });
    return p.id;
  }
  const plasticos = await plasticosDeTarjeta(db, tarjetaId);
  if (plasticos.length === 0) return null;
  if (op.ultimos4) {
    const coincide = plasticos.find((p) => p.ultimos_4 === op.ultimos4);
    if (coincide) return coincide.id;
  }
  const deducido = plasticoParaFecha(plasticos.map(aBase), op.fecha ?? null);
  return deducido ? BigInt(deducido.plastico.id) : null;
}

/** Al enlazar un aviso con una compra que ya existía: si la compra no tiene plástico y el aviso trae dígitos conocidos, se lo asigna. */
export async function completarPlasticoDeCompra(db: Db, compraId: bigint, ultimos4: string | null): Promise<void> {
  if (!ultimos4) return;
  await db.$executeRaw`
    UPDATE "ComprasCredito" c
       SET plastico_id = p.id
      FROM "TarjetaPlasticos" p
     WHERE c.id = ${compraId}::int8 AND c.plastico_id IS NULL AND p.tarjeta_id = c.tarjeta AND p.ultimos_4 = ${ultimos4}`;
}

export interface ReemplazoSolicitado {
  ultimos4: string;
  inicio: Date;
  motivo: MotivoReemplazo | null;
  notas: string | null;
}

/**
 * Reemplaza el plástico activo de una tarjeta por uno nuevo (o reactiva uno archivado con esos dígitos) en la misma transacción:
 * el anterior queda archivado con su fecha de cierre y se conserva todo el historial (compras y cuotas siguen en la misma línea).
 */
export async function reemplazarPlastico(db: Db, tarjeta: { id: bigint; owner_user_id: bigint | null }, r: ReemplazoSolicitado): Promise<{ nuevo: TarjetaPlasticos; anterior: TarjetaPlasticos | null }> {
  const plasticos = await plasticosDeTarjeta(db, tarjeta.id);
  const activo = plasticos.find((p) => p.es_activo) ?? null;
  const mismo = plasticos.find((p) => p.ultimos_4 === r.ultimos4) ?? null;

  if (mismo && mismo.es_activo) {
    throw new HttpException({ message: `El plástico terminado en ${r.ultimos4} ya es el activo de esta tarjeta` }, HttpStatus.CONFLICT);
  }
  if (tarjeta.owner_user_id !== null) {
    const ocupante = await ocupanteDeUltimos4(db, tarjeta.owner_user_id, r.ultimos4, tarjeta.id);
    if (ocupante) throw new HttpException({ message: `Los dígitos ${r.ultimos4} ya pertenecen a "${ocupante}"` }, HttpStatus.CONFLICT);
  }
  if (activo?.vigente_desde && r.inicio.getTime() < activo.vigente_desde.getTime()) {
    throw datosInvalidos({ vigenteDesde: [`El reemplazo no puede empezar antes del plástico actual (${formatIsoDate(activo.vigente_desde)})`] });
  }

  if (activo) {
    await db.tarjetaPlasticos.update({ where: { id: activo.id }, data: { es_activo: false, vigente_hasta: cierreDelAnterior(activo.vigente_desde, r.inicio) } });
  }

  const nuevo = mismo
    ? await db.tarjetaPlasticos.update({
        where: { id: mismo.id },
        data: { es_activo: true, vigente_desde: r.inicio, vigente_hasta: null, reemplaza_a_id: activo?.id ?? mismo.reemplaza_a_id, motivo_reemplazo: r.motivo, ...(r.notas !== null ? { notas: r.notas } : {}) },
      })
    : await db.tarjetaPlasticos.create({
        data: { tarjeta_id: tarjeta.id, owner_user_id: tarjeta.owner_user_id, ultimos_4: r.ultimos4, es_activo: true, vigente_desde: r.inicio, reemplaza_a_id: activo?.id ?? null, motivo_reemplazo: r.motivo, notas: r.notas },
      });
  await sincronizarCadena(db, tarjeta.id);
  return { nuevo, anterior: activo ? await db.tarjetaPlasticos.findUniqueOrThrow({ where: { id: activo.id } }) : null };
}
