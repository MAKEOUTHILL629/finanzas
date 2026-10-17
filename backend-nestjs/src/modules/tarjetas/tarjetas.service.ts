import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TarjetaPlasticos, Tarjetas } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import { isValidPeriodo, parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { money, rate, toDb, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { formatLegacyIso, idNum, numOrNull, timestampToDayMillis } from '../../common/utils/legacy-format.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarTarjetaDto } from './dto/actualizar-tarjeta.dto';
import { CrearTarjetaDto } from './dto/crear-tarjeta.dto';
import { PagarExtractoDto } from './dto/pagar-extracto.dto';
import { asegurarPlastico, ocupanteDeUltimos4, reemplazarPlastico, sincronizarCadena } from './plasticos.db';
import { anotarPlasticos, plasticoJson } from './plasticos-tarjeta.service';
import { tokensUltimos4 } from './plasticos.util';
import { ResultadoScrapingTarjeta, TarjetaScrapeable, WebScrapingService } from './web-scraping.service';
import { TipoTarjeta } from './tipos-tarjeta.util';

interface ResumenScraping {
  tarjetaId: number;
  franquicia: string;
  estado: 'ACTUALIZADA' | 'OMITIDA' | 'ERROR';
  mensaje: string;
  resultado?: ResultadoScrapingTarjeta;
}

/** Persona «yo» del AppSheet original (la misma que usan los triggers del sub-ledger). */
const LEGACY_YO = 'lm1R40P16oHgkM3Szu91du';

const num = (d: Decimal | null): number | null => (d ? d.toNumber() : null);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tasasJson(r: ResultadoScrapingTarjeta) {
  return {
    interesCompraMensual: num(r.tasaInteresCompraMensual),
    interesCompraAnual: num(r.tasaInteresCompraAnual),
    interesAvanceMensual: num(r.tasaInteresAvanceMensual),
    interesAvanceAnual: num(r.tasaInteresAvanceAnual),
    cuotaManejo: num(r.cuotaManejo),
  };
}

@Injectable()
export class TarjetasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scraping: WebScrapingService,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────── legacy ─────────────────────────────

  /**
   * `GET /api/tarjetas` — JSON de `tarjetaEscritura` (fechas `yyyy-MM-dd'T'HH:mm:ss`) + los plásticos de cada tarjeta:
   * `plasticoActivo` es el que debe ofrecerse en compras nuevas; `plasticos` trae también los archivados (historial).
   */
  async list(ownerUserId: bigint) {
    const tarjetas = await this.prisma.tarjetas.findMany({
      where: { owner_user_id: ownerUserId },
      include: { plasticos: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    return tarjetas.map((t) => this.tarjetaJson(t));
  }

  /**
   * `POST /api/tarjetas` — crea una tarjeta (crédito o débito) con su primer plástico, o un plástico que RENUEVA a otro
   * (`plasticoAnteriorId`: el anterior queda archivado con todo su historial). Una cuenta puede tener varias tarjetas.
   */
  async crear(dto: CrearTarjetaDto, ownerUserId: bigint) {
    const tipo: TipoTarjeta = dto.tipo;
    const esGenerica = dto.esGenerica === true;
    if (!dto.ultimos4 && !esGenerica) throw datosInvalidos({ ultimos4: ['Indica los últimos 4 dígitos del plástico (solo un producto «sin número» puede omitirlos)'] });
    if (dto.plasticoAnteriorId !== undefined && (dto.estado === 'INACTIVA' || esGenerica)) {
      throw datosInvalidos({ plasticoAnteriorId: ['Una renovación crea el plástico vigente de la tarjeta; no puede ser histórica ni «sin número»'] });
    }
    const inicio = dto.fechaInicioUso ? parseIsoDate(dto.fechaInicioUso) : null;
    const fin = dto.fechaFinUso ? parseIsoDate(dto.fechaFinUso) : null;
    if (dto.fechaInicioUso && !inicio) throw datosInvalidos({ fechaInicioUso: ['fechaInicioUso debe tener formato yyyy-MM-dd'] });
    if (dto.fechaFinUso && !fin) throw datosInvalidos({ fechaFinUso: ['fechaFinUso debe tener formato yyyy-MM-dd'] });
    if (inicio && fin && inicio.getTime() > fin.getTime()) throw datosInvalidos({ fechaFinUso: ['La fecha de fin no puede ser anterior al inicio'] });
    if (fin && dto.estado !== 'INACTIVA') throw datosInvalidos({ fechaFinUso: ['Solo una tarjeta histórica (INACTIVA) tiene fecha de fin'] });

    const id = await this.prisma.$transaction(async (tx) => {
      if (dto.plasticoAnteriorId !== undefined) return this.renovar(tx, dto, ownerUserId, inicio);

      const cuentaId = await this.validarCuenta(tx, tipo, dto.cuentaId ?? null, ownerUserId);
      if (dto.ultimos4) {
        const ocupante = await ocupanteDeUltimos4(tx, ownerUserId, dto.ultimos4);
        if (ocupante) throw new HttpException({ message: `Los dígitos ${dto.ultimos4} ya pertenecen a "${ocupante}"` }, HttpStatus.CONFLICT);
      }
      const linea = await tx.tarjetas.create({
        data: {
          owner_user_id: ownerUserId,
          tipo_tarjeta: tipo,
          cuenta_id: cuentaId,
          franquicia: dto.franquicia?.trim() || (tipo === 'DEBITO' ? 'Débito' : 'Tarjeta de crédito'),
          descripcion: dto.descripcion?.trim() || null,
          alias: dto.alias?.trim() || null,
          es_generica: esGenerica,
          ...(tipo === 'CREDITO'
            ? {
                dia_corte: dto.diaCorte ?? null,
                dia_limite_pago: dto.diaLimitePago ?? null,
                cupo_total: dto.cupoTotal !== undefined ? toDbMoney(toDecimal(dto.cupoTotal)) : null,
              }
            : {}),
        },
      });
      if (dto.ultimos4) {
        const activo = dto.estado !== 'INACTIVA';
        await tx.tarjetaPlasticos.create({
          data: {
            tarjeta_id: linea.id,
            owner_user_id: ownerUserId,
            ultimos_4: dto.ultimos4,
            es_activo: activo,
            vigente_desde: inicio ?? (activo ? todayLocal() : null),
            vigente_hasta: activo ? null : fin,
            notas: dto.notas?.trim() || null,
          },
        });
        await sincronizarCadena(tx, linea.id);
      }
      return linea.id;
    });
    return this.obtener(id, ownerUserId);
  }

  /** Renovación: el plástico nuevo entra en la línea del anterior (que queda archivado) y se conserva el historial de compras. */
  private async renovar(tx: Prisma.TransactionClient, dto: CrearTarjetaDto, ownerUserId: bigint, inicio: Date | null): Promise<bigint> {
    const anterior = await tx.tarjetaPlasticos.findFirst({
      where: { id: BigInt(dto.plasticoAnteriorId as number), tarjeta: { owner_user_id: ownerUserId } },
      select: { tarjeta: { select: { id: true, owner_user_id: true, tipo_tarjeta: true } } },
    });
    if (!anterior) throw new HttpException({ message: `Plástico ${dto.plasticoAnteriorId} no encontrado` }, HttpStatus.NOT_FOUND);
    if (anterior.tarjeta.tipo_tarjeta !== dto.tipo) {
      throw datosInvalidos({ tipo: [`El plástico anterior es de una tarjeta de ${anterior.tarjeta.tipo_tarjeta === 'DEBITO' ? 'débito' : 'crédito'}`] });
    }
    await reemplazarPlastico(tx, anterior.tarjeta, {
      ultimos4: dto.ultimos4 as string,
      inicio: inicio ?? todayLocal(),
      motivo: dto.motivo ?? null,
      notas: dto.notas?.trim() || null,
    });
    return anterior.tarjeta.id;
  }

  /** La cuenta existe y es del usuario; en débito es obligatoria. Devuelve el id a guardar (o null). */
  private async validarCuenta(db: Pick<Prisma.TransactionClient, 'cuentasFinancieras'>, tipo: TipoTarjeta, cuentaId: number | null, ownerUserId: bigint): Promise<bigint | null> {
    if (cuentaId === null) {
      if (tipo === 'DEBITO') throw datosInvalidos({ cuentaId: ['Una tarjeta de débito pertenece a una cuenta: elige cuál'] });
      return null;
    }
    const cuenta = await db.cuentasFinancieras.findFirst({ where: { id: BigInt(cuentaId), owner_user_id: ownerUserId }, select: { id: true } });
    if (!cuenta) throw new HttpException({ message: `Cuenta ${cuentaId} no encontrada` }, HttpStatus.NOT_FOUND);
    return cuenta.id;
  }

  /** Una tarjeta con sus plásticos, con la misma forma que `GET /api/tarjetas`. */
  async obtener(id: bigint | number, ownerUserId: bigint) {
    const t = await this.prisma.tarjetas.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, include: { plasticos: { orderBy: { id: 'asc' } } } });
    if (!t) throw new HttpException({ message: `Tarjeta ${id} no encontrada` }, HttpStatus.NOT_FOUND);
    return this.tarjetaJson(t);
  }

  /**
   * `PUT /api/tarjetas/:id` — edita la configuración de una tarjeta (día de corte, límite de pago, cupo, tasas…).
   * Solo se escriben los campos recibidos. Devuelve la tarjeta con la misma forma que `GET /api/tarjetas`.
   */
  async actualizar(id: number, dto: ActualizarTarjetaDto, ownerUserId: bigint) {
    const actual = await this.prisma.tarjetas.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!actual) throw new HttpException({ message: `Tarjeta ${id} no encontrada` }, HttpStatus.NOT_FOUND);

    const data: Prisma.TarjetasUncheckedUpdateInput = {};
    const tipoFinal = (dto.tipo ?? actual.tipo_tarjeta) as TipoTarjeta;
    const cuentaFinal = dto.cuentaId === undefined ? (actual.cuenta_id === null ? null : idNum(actual.cuenta_id)) : dto.cuentaId;
    if (dto.tipo !== undefined && dto.tipo !== actual.tipo_tarjeta) {
      if (dto.tipo === 'DEBITO') {
        const compras = await this.prisma.comprasCredito.count({ where: { tarjeta: actual.id } });
        if (compras > 0) throw new HttpException({ message: `La tarjeta tiene ${compras} compra(s) a crédito: no puede pasar a débito` }, HttpStatus.CONFLICT);
      }
      data.tipo_tarjeta = dto.tipo;
    }
    if (dto.tipo !== undefined || dto.cuentaId !== undefined) data.cuenta_id = await this.validarCuenta(this.prisma, tipoFinal, cuentaFinal, ownerUserId);
    if (dto.alias !== undefined) data.alias = dto.alias.trim() || null;
    if (dto.franquicia !== undefined) data.franquicia = dto.franquicia.trim();
    if (dto.descripcion !== undefined) data.descripcion = dto.descripcion.trim();
    if (dto.diaCorte !== undefined) data.dia_corte = dto.diaCorte;
    if (dto.diaLimitePago !== undefined) data.dia_limite_pago = dto.diaLimitePago;
    if (dto.cupoTotal !== undefined) data.cupo_total = toDbMoney(toDecimal(dto.cupoTotal));
    if (dto.permiteDolares !== undefined) data.permite_dolares = dto.permiteDolares;
    if (dto.tasaInteresCompra !== undefined) data.tasa_interes_compra = toDbRate(toDecimal(dto.tasaInteresCompra));
    if (dto.tasaInteresAvance !== undefined) data.tasa_interes_avance = toDbRate(toDecimal(dto.tasaInteresAvance));
    if (dto.cuotaManejo !== undefined) data.cuota_manejo = toDbMoney(toDecimal(dto.cuotaManejo));
    if (dto.urlInfo !== undefined) data.url_info = dto.urlInfo.trim() || null;
    if (dto.extractTasas !== undefined) data.extract_tasas = dto.extractTasas;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) await tx.tarjetas.update({ where: { id: actual.id }, data });
      if (dto.ultimos4Digitos !== undefined) await this.aplicarUltimos4(tx, actual, dto.ultimos4Digitos);
    });
    const guardada = await this.prisma.tarjetas.findUniqueOrThrow({ where: { id: actual.id }, include: { plasticos: { orderBy: { id: 'asc' } } } });
    return this.tarjetaJson(guardada);
  }

  /**
   * Compatibilidad con la edición clásica de `ultimos4Digitos` ("1927,9587"): cada grupo es un plástico de la tarjeta. Los nuevos se
   * registran (`asegurarPlastico`); los que se quitan se eliminan solo si no tienen compras asociadas. Después `Tarjetas.ultimos_4_digitos`
   * vuelve a ser la lista de TODOS los plásticos que quedan.
   */
  private async aplicarUltimos4(tx: Prisma.TransactionClient, tarjeta: Tarjetas, texto: string): Promise<void> {
    const deseados = tokensUltimos4(texto);
    const actuales = await tx.tarjetaPlasticos.findMany({ where: { tarjeta_id: tarjeta.id }, include: { _count: { select: { compras: true } } } });

    for (const u4 of deseados.filter((d) => !actuales.some((p) => p.ultimos_4 === d))) {
      if (tarjeta.owner_user_id !== null) {
        const ocupante = await ocupanteDeUltimos4(tx, tarjeta.owner_user_id, u4, tarjeta.id);
        if (ocupante) throw new HttpException({ message: `Los dígitos ${u4} ya pertenecen a "${ocupante}"` }, HttpStatus.CONFLICT);
      }
      await asegurarPlastico(tx, tarjeta, u4);
    }
    const sobrantes = actuales.filter((p) => !deseados.includes(p.ultimos_4) && p._count.compras === 0);
    // Nunca se deja sin plástico activo a una tarjeta que conserva otros: si se quita el activo, pasa a serlo el más reciente.
    for (const p of sobrantes) await tx.tarjetaPlasticos.delete({ where: { id: p.id } });
    const restantes = await tx.tarjetaPlasticos.findMany({ where: { tarjeta_id: tarjeta.id }, orderBy: { id: 'desc' } });
    if (restantes.length > 0 && !restantes.some((p) => p.es_activo)) {
      await tx.tarjetaPlasticos.update({ where: { id: restantes[0].id }, data: { es_activo: true, vigente_hasta: null } });
    }
    if (restantes.length === 0) await tx.tarjetas.update({ where: { id: tarjeta.id }, data: { ultimos_4_digitos: null } });
    else await sincronizarCadena(tx, tarjeta.id);
  }

  /** `GET /api/tarjetas/balance?mes&year` — saldo restante de cuotas pendientes por tarjeta. */
  async balance(mes: number, year: number, ownerUserId: bigint) {
    const rows = await this.prisma.$queryRaw<Array<{ tarjeta: bigint; franquicia: string | null; total: Prisma.Decimal }>>`
      SELECT cc.tarjeta AS tarjeta, t.franquicia AS franquicia, SUM(cd.saldo_restante) AS total
      FROM "CuotasDetalle" cd
      JOIN "ComprasCredito" cc ON cd.compra = cc.id
      JOIN "Tarjetas" t ON cc.tarjeta = t.id
      WHERE UPPER(cd.estado) = 'PENDIENTE'
        AND EXTRACT(MONTH FROM cd.fecha_pago) = ${mes}::int
        AND EXTRACT(YEAR FROM cd.fecha_pago) = ${year}::int
        AND cc.owner_user_id = ${ownerUserId}::int8
      GROUP BY cc.tarjeta, t.franquicia`;
    return rows.map((r) => ({
      tarjeta: idNum(r.tarjeta),
      franquicia: r.franquicia,
      total_saldo_restante: r.total.toNumber(),
    }));
  }

  /**
   * `POST /api/tarjetas/actualizar-tasas`: recorre las tarjetas con scraping habilitado, omite las actualizadas
   * hace menos de 7 días y espera entre requests para no sobrecargar los sitios.
   */
  async actualizarTodas(ownerUserId: bigint) {
    const tarjetas = await this.prisma.tarjetas.findMany({
      where: { owner_user_id: ownerUserId, extract_tasas: true, url_info: { not: null } },
      orderBy: { id: 'asc' },
    });

    if (tarjetas.length === 0) {
      return {
        mensaje: 'No hay tarjetas configuradas para scraping (extract_tasas = true y url_info no nulo)',
        total: 0,
        resultados: [] as unknown[],
      };
    }

    const delayMs = Number(this.config.get<number | string>('SCRAPING_DELAY_MS') ?? 2000);
    const resultados: ResumenScraping[] = [];

    for (const tarjeta of tarjetas) {
      const scrapeable = this.toScrapeable(tarjeta);
      if (!this.scraping.necesitaActualizacion(scrapeable)) {
        resultados.push({
          tarjetaId: scrapeable.id,
          franquicia: scrapeable.franquicia,
          estado: 'OMITIDA',
          mensaje: `Actualizada recientemente. Próxima actualización disponible en ${this.scraping.diasRestantes(scrapeable)} día(s).`,
        });
        continue;
      }

      if (delayMs > 0) await sleep(delayMs);
      const resultado = await this.scraping.extraerTasas(scrapeable);
      if (resultado.exitoso) {
        await this.guardarTasas(tarjeta.id, resultado);
        resultados.push({
          tarjetaId: scrapeable.id,
          franquicia: scrapeable.franquicia,
          estado: 'ACTUALIZADA',
          mensaje: resultado.mensaje,
          resultado,
        });
      } else {
        resultados.push({
          tarjetaId: scrapeable.id,
          franquicia: scrapeable.franquicia,
          estado: 'ERROR',
          mensaje: resultado.mensaje,
        });
      }
    }

    const actualizadas = resultados.filter((r) => r.estado === 'ACTUALIZADA').length;
    const omitidas = resultados.filter((r) => r.estado === 'OMITIDA').length;
    const errores = resultados.filter((r) => r.estado === 'ERROR').length;

    return {
      mensaje: `Proceso completado: ${actualizadas} actualizadas, ${omitidas} omitidas, ${errores} con error`,
      total: tarjetas.length,
      actualizadas,
      omitidas,
      errores,
      resultados: resultados.map((r) => ({
        tarjetaId: r.tarjetaId,
        franquicia: r.franquicia,
        estado: r.estado,
        mensaje: r.mensaje,
        ...(r.resultado ? { tasas: tasasJson(r.resultado) } : {}),
      })),
    };
  }

  /** `POST /api/tarjetas/:id/actualizar-tasas`: fuerza una tarjeta (ignora la restricción semanal). */
  async actualizarUna(tarjetaId: number, ownerUserId: bigint) {
    const tarjeta = await this.prisma.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId } });
    if (!tarjeta) {
      throw new HttpException({ mensaje: `No se encontró la tarjeta con id=${tarjetaId}` }, HttpStatus.NOT_FOUND);
    }
    if (!tarjeta.extract_tasas) {
      throw new HttpException(
        { mensaje: 'La tarjeta no tiene habilitado el scraping (extract_tasas = false)' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!tarjeta.url_info) {
      throw new HttpException({ mensaje: 'La tarjeta no tiene URL configurada (url_info)' }, HttpStatus.BAD_REQUEST);
    }

    const resultado = await this.scraping.extraerTasas(this.toScrapeable(tarjeta));
    if (!resultado.exitoso) {
      throw new HttpException(
        { mensaje: resultado.mensaje, tarjetaId: idNum(tarjeta.id), franquicia: tarjeta.franquicia },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.guardarTasas(tarjeta.id, resultado);
    return {
      mensaje: 'Tasas actualizadas correctamente',
      tarjetaId: idNum(tarjeta.id),
      franquicia: tarjeta.franquicia,
      tasas: tasasJson(resultado),
    };
  }

  /** Igual que el legacy: se escriben las tres columnas (NULL si el scraping no encontró ese dato). */
  private async guardarTasas(tarjetaId: bigint, r: ResultadoScrapingTarjeta): Promise<void> {
    await this.prisma.tarjetas.update({
      where: { id: tarjetaId },
      data: {
        tasa_interes_compra: r.tasaInteresCompraMensual ? toDb(rate(r.tasaInteresCompraMensual)) : null,
        tasa_interes_avance: r.tasaInteresAvanceMensual ? toDb(rate(r.tasaInteresAvanceMensual)) : null,
        cuota_manejo: r.cuotaManejo ? toDb(money(r.cuotaManejo)) : null,
        ultima_actualizacion_tasas: new Date(),
      },
    });
  }

  // ───────────────────────────── ERP v2 ─────────────────────────────

  /**
   * `POST /api/v2/tarjetas/:id/pagar-extracto` → `sp_pagar_extracto_tarjeta`.
   * El SP inserta la Transacción PAGO_TARJETA (el Trigger 2 descuenta el saldo de la cuenta) y marca las cuotas del
   * periodo como PAGADA. NO se toca `CuentasFinancieras.saldo_actual` desde aquí.
   */
  async pagarExtracto(tarjetaId: number, ownerUserId: bigint, dto: PagarExtractoDto) {
    const monto = money(toDecimal(dto.montoPagado));
    if (!monto.greaterThan(0)) throw datosInvalidos({ montoPagado: ['montoPagado debe ser mayor a 0'] });

    const [tarjeta, cuenta] = await Promise.all([
      this.prisma.tarjetas.findFirst({ where: { id: BigInt(tarjetaId), owner_user_id: ownerUserId }, select: { id: true } }),
      this.prisma.cuentasFinancieras.findFirst({
        where: { id: BigInt(dto.cuentaOrigenId), owner_user_id: ownerUserId },
        select: { id: true },
      }),
    ]);
    if (!tarjeta) throw new HttpException({ message: `Tarjeta ${tarjetaId} no encontrada` }, HttpStatus.NOT_FOUND);
    if (!cuenta) {
      throw new HttpException({ message: `Cuenta financiera ${dto.cuentaOrigenId} no encontrada` }, HttpStatus.NOT_FOUND);
    }

    const rows = await this.prisma.$queryRaw<Array<{ transaccion_id: bigint }>>`
      SELECT sp_pagar_extracto_tarjeta(
        ${ownerUserId}::int8, ${tarjeta.id}::int8, ${cuenta.id}::int8, ${dto.periodo}::char(7), ${toDbMoney(monto)}::numeric(15,2)
      ) AS transaccion_id`;
    return {
      transaccionId: idNum(rows[0]?.transaccion_id),
      tarjetaId,
      cuentaOrigenId: dto.cuentaOrigenId,
      periodo: dto.periodo,
      montoPagado: monto.toNumber(),
    };
  }

  /**
   * `GET /api/v2/tarjetas/resumen-mensual?periodo=YYYY-MM` — consulta 7.3 (lo tuyo vs. lo de terceros + USD).
   *
   * Corrige tres defectos de la versión del documento (detectados contra PostgreSQL real):
   *  1. El `LEFT JOIN` directo a `ResponsablesComprasCredito` multiplicaba las cuotas cuando una compra tenía más de un
   *     tercero (`SUM(pago_total)` salía duplicado). Ahora el % de terceros se agrega por cuota (subconsulta lateral) y no se une fila a fila.
   *  2. `rcc.persona <> (SELECT ...)` es NULL si el usuario no tiene Persona enlazada, y entonces nadie contaba como
   *     tercero. Se usa `IS DISTINCT FROM`.
   *  3. Un responsable con `cantidad_cuotas` = N solo paga las N primeras cuotas: el % se aplica cuota a cuota, no a toda la compra.
   *
   * Cada fila trae además `terceros`: cuánto le toca a cada persona de ese extracto (para mostrar «de esto, X es de Andrés»).
   */
  async resumenMensual(periodo: string, ownerUserId: bigint) {
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });
    const filas = await this.prisma.$queryRaw<Array<Omit<ResumenMensualTarjetaRow, 'terceros'>>>`
      WITH mi_persona AS (
        SELECT id FROM "Personas" WHERE linked_user_id = ${ownerUserId}::int8 OR legacy_appsheet_id = ${LEGACY_YO} ORDER BY id LIMIT 1
      )
      SELECT
        t.id AS tarjeta_id,
        t.franquicia,
        t.descripcion AS nombre_tarjeta,
        t.dia_corte,
        t.dia_limite_pago,
        cd.periodo_facturacion,
        COUNT(DISTINCT cd.id) AS total_cuotas_mes,
        SUM(cd.pago_total)::numeric(15,2) AS total_extracto_cop,
        SUM(CASE WHEN cc.moneda_original = 'USD' THEN (cd.pago_total / NULLIF(cc.tasa_cambio_aplicada, 0)) ELSE 0 END)::numeric(15,2) AS componente_en_usd,
        BOOL_AND(COALESCE(cc.trm_confirmada, true)) AS todas_trm_confirmadas,
        COALESCE(SUM(cd.pago_total * (tr.pct_terceros / 100.0)), 0)::numeric(15,2) AS total_responsabilidad_terceros,
        (SUM(cd.pago_total) - COALESCE(SUM(cd.pago_total * (tr.pct_terceros / 100.0)), 0))::numeric(15,2) AS total_propio
      FROM "Tarjetas" t
      JOIN "ComprasCredito" cc ON cc.tarjeta = t.id
      JOIN "CuotasDetalle" cd ON cd.compra = cc.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(rcc.porcentaje_pago), 0) AS pct_terceros
        FROM "ResponsablesComprasCredito" rcc
        WHERE rcc.compra_credito = cc.id
          AND rcc.persona IS NOT NULL
          AND rcc.persona IS DISTINCT FROM (SELECT id FROM mi_persona)
          AND (rcc.cantidad_cuotas IS NULL OR cd.numero_cuota <= rcc.cantidad_cuotas)
      ) tr ON true
      WHERE t.owner_user_id = ${ownerUserId}::int8
        AND cd.periodo_facturacion = ${periodo}::char(7)
        AND UPPER(COALESCE(cd.estado, '')) <> 'REFINANCIADA'
      GROUP BY t.id, t.franquicia, t.descripcion, t.dia_corte, t.dia_limite_pago, cd.periodo_facturacion`;

    const porPersona = await this.prisma.$queryRaw<Array<{ tarjeta_id: bigint; persona_id: bigint; nombre: string | null; monto: Prisma.Decimal }>>`
      WITH mi_persona AS (
        SELECT id FROM "Personas" WHERE linked_user_id = ${ownerUserId}::int8 OR legacy_appsheet_id = ${LEGACY_YO} ORDER BY id LIMIT 1
      )
      SELECT cc.tarjeta AS tarjeta_id, p.id AS persona_id, p.nombre,
             SUM(ROUND((cd.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2))::numeric(15,2) AS monto
      FROM "ComprasCredito" cc
      JOIN "CuotasDetalle" cd ON cd.compra = cc.id
      JOIN "ResponsablesComprasCredito" rcc ON rcc.compra_credito = cc.id
        AND (rcc.cantidad_cuotas IS NULL OR cd.numero_cuota <= rcc.cantidad_cuotas)
      JOIN "Personas" p ON p.id = rcc.persona
      WHERE cc.owner_user_id = ${ownerUserId}::int8
        AND cd.periodo_facturacion = ${periodo}::char(7)
        AND UPPER(COALESCE(cd.estado, '')) <> 'REFINANCIADA'
        AND rcc.persona IS DISTINCT FROM (SELECT id FROM mi_persona)
      GROUP BY cc.tarjeta, p.id, p.nombre
      HAVING SUM(ROUND((cd.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2)) > 0
      ORDER BY monto DESC, p.nombre`;

    return filas.map((f) => ({
      ...f,
      terceros: porPersona
        .filter((r) => r.tarjeta_id === f.tarjeta_id)
        .map((r) => ({ personaId: r.persona_id, nombre: r.nombre, monto: r.monto })),
    }));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** JSON de `tarjetaEscritura` (legacy) + los campos del esquema Supabase + los plásticos. */
  private tarjetaJson(t: Tarjetas & { plasticos?: TarjetaPlasticos[] }) {
    const plasticos = anotarPlasticos((t.plasticos ?? []).map((p) => plasticoJson(p)).sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || b.id - a.id));
    const activo = plasticos.find((p) => p.esActivo) ?? null;
    return {
      id: idNum(t.id),
      franquicia: t.franquicia,
      /** CREDITO | DEBITO. Una tarjeta de débito pertenece a una cuenta (`cuentaId`) y no tiene compras a crédito. */
      tipo: t.tipo_tarjeta as TipoTarjeta,
      cuentaId: t.cuenta_id === null ? null : idNum(t.cuenta_id),
      alias: t.alias,
      esGenerica: t.es_generica,
      fechaCreacion: this.fechaCreacionIso(t),
      descripcion: t.descripcion,
      tasaInteresCompra: numOrNull(t.tasa_interes_compra),
      tasaInteresAvance: numOrNull(t.tasa_interes_avance),
      cuotaManejo: numOrNull(t.cuota_manejo),
      urlInfo: t.url_info,
      ultimaActualizacionTasas: formatLegacyIso(t.ultima_actualizacion_tasas),
      extractTasas: t.extract_tasas,
      // Campos nuevos del esquema Supabase (no existían en el legacy; Angular los ignora).
      diaCorte: t.dia_corte,
      diaLimitePago: t.dia_limite_pago,
      cupoTotal: numOrNull(t.cupo_total),
      permiteDolares: t.permite_dolares,
      /** Todos los plásticos (lista separada por comas), el activo primero. */
      ultimos4Digitos: t.ultimos_4_digitos,
      /** Plástico vigente: el que se ofrece al registrar compras nuevas. */
      ultimos4Activo: activo?.ultimos4 ?? null,
      plasticoActivo: activo,
      plasticos,
    };
  }

  private fechaCreacionIso(t: Tarjetas): string | null {
    const dia = timestampToDayMillis(t.created_at);
    return dia === null ? null : formatLegacyIso(new Date(dia));
  }

  private toScrapeable(t: Tarjetas): TarjetaScrapeable {
    return {
      id: idNum(t.id),
      franquicia: t.franquicia ?? '',
      urlInfo: t.url_info,
      ultimaActualizacionTasas: t.ultima_actualizacion_tasas,
    };
  }
}

export interface ResumenMensualTarjetaRow {
  tarjeta_id: bigint;
  franquicia: string | null;
  nombre_tarjeta: string | null;
  dia_corte: number | null;
  dia_limite_pago: number | null;
  periodo_facturacion: string;
  total_cuotas_mes: bigint;
  total_extracto_cop: Prisma.Decimal;
  componente_en_usd: Prisma.Decimal;
  todas_trm_confirmadas: boolean;
  total_responsabilidad_terceros: Prisma.Decimal;
  total_propio: Prisma.Decimal;
  /** Cuánto le toca a cada tercero de este extracto (ya está incluido en `total_responsabilidad_terceros`). */
  terceros: Array<{ personaId: bigint; nombre: string | null; monto: Prisma.Decimal }>;
}
