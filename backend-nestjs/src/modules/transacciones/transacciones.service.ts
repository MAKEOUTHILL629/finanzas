import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Transacciones } from '@prisma/client';
import { EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { money, rate, toDbMoney, toDbRate, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCategoria, assertCuenta, assertTarjeta } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { colorSugeridoTag, nombreLegibleTag } from '../lookup/lookup.service';
import { inferirComercioYTags, normalizarTagSlug, normalizarTags } from '../notificaciones-correo/comercio.util';
import {
  CrearTransferenciaInternaDto,
  CreateTransaccionDto,
  TransaccionesFiltroDto,
  UpdateTransaccionDto,
} from './dto/transaccion.dto';
import { validarReglasTransaccion } from './transaccion.rules';
import { encontrarPersona } from '../notificaciones-correo/persona-match.util';
import {
  MovimientoTransferencia,
  agruparPorDestinatario,
  extraerIdentidadTransferencia,
  normalizarNombreDestinatario,
  serieMensualTransferencias,
} from './transferencia-identidad.util';

type Tx = Prisma.TransactionClient;

export interface DatosTransaccion {
  tipoTransaccion: TipoTransaccion;
  cuentaOrigenId: number | null;
  cuentaDestinoId: number | null;
  tarjetaPagadaId: number | null;
  categoriaId: number | null;
  fechaTransaccion: Date;
  concepto: string;
  monedaOriginal: string;
  montoOriginal: number | string;
  tasaCambio?: number | string | null;
  montoCop?: number | string | null;
  origenRegistro: OrigenRegistro;
  estado: EstadoTransaccion;
  notas: string | null;
  esTransferenciaInterna?: boolean;
  cuentaContraparteId?: number | null;
  transaccionEspejoId?: number | null;
  tags?: string[];
  comercioCanonico?: string | null;
}

export interface ResultadoTransferenciaPropia {
  salida: Transacciones;
  entrada: Transacciones;
  comision: Transacciones | null;
}

/**
 * Libro diario. NUNCA se escribe `CuentasFinancieras.saldo_actual` desde aquí: el Trigger 2
 * (`trg_actualizar_saldo_cuenta`) lo ajusta al insertar/actualizar/eliminar una transacción CONFIRMADA.
 */
@Injectable()
export class TransaccionesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerUserId: bigint, filtro: TransaccionesFiltroDto) {
    const tipo = filtro.tipo ?? filtro.tipo_transaccion;
    const cuentaId = filtro.cuentaId ?? filtro.cuenta_id;
    const categoriaId = filtro.categoriaId ?? filtro.categoria_id;
    const tagNorm = filtro.tag ? normalizarTagSlug(filtro.tag) : '';
    const rango = filtro.periodo ? this.rangoDelPeriodo(filtro.periodo) : { desde: filtro.desde, hasta: filtro.hasta };
    const where: Prisma.TransaccionesWhereInput = {
      owner_user_id: ownerUserId,
      ...(tipo ? { tipo_transaccion: tipo } : {}),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.origen_registro ? { origen_registro: filtro.origen_registro } : {}),
      ...(filtro.esTransferenciaInterna !== undefined ? { es_transferencia_interna: filtro.esTransferenciaInterna } : {}),
      ...(tagNorm ? { tags: { has: tagNorm } } : {}),
      ...(categoriaId ? { categoria_id: BigInt(categoriaId) } : {}),
      ...(cuentaId ? { OR: [{ cuenta_origen_id: BigInt(cuentaId) }, { cuenta_destino_id: BigInt(cuentaId) }] } : {}),
      ...(rango.desde || rango.hasta
        ? {
            fecha_transaccion: {
              ...(rango.desde ? { gte: new Date(rango.desde) } : {}),
              ...(rango.hasta ? { lte: this.finDeDia(rango.hasta) } : {}),
            },
          }
        : {}),
    };
    const limit = filtro.limit ?? 100;
    const offset = filtro.offset ?? 0;
    const [total, items] = await Promise.all([
      this.prisma.transacciones.count({ where }),
      this.prisma.transacciones.findMany({
        where,
        orderBy: [{ fecha_transaccion: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
    ]);
    return { total, limit, offset, items };
  }

  async get(id: number, ownerUserId: bigint): Promise<Transacciones> {
    const tx = await this.prisma.transacciones.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!tx) throw new NotFoundException(`Transacción ${id} no encontrada`);
    return tx;
  }

  async create(dto: CreateTransaccionDto, ownerUserId: bigint): Promise<Transacciones> {
    const origenRegistro = dto.origenRegistro ?? OrigenRegistro.MANUAL;
    const datos: DatosTransaccion = {
      tipoTransaccion: dto.tipoTransaccion,
      cuentaOrigenId: dto.cuentaOrigenId ?? null,
      cuentaDestinoId: dto.cuentaDestinoId ?? null,
      tarjetaPagadaId: dto.tarjetaPagadaId ?? null,
      categoriaId: dto.categoriaId ?? null,
      fechaTransaccion: dto.fechaTransaccion ? new Date(dto.fechaTransaccion) : new Date(),
      concepto: dto.concepto,
      monedaOriginal: (dto.monedaOriginal ?? 'COP').toUpperCase(),
      montoOriginal: dto.montoOriginal,
      tasaCambio: dto.tasaCambio,
      montoCop: dto.montoCop,
      origenRegistro,
      estado:
        dto.estado ??
        (origenRegistro === OrigenRegistro.EMAIL_AUTO ? EstadoTransaccion.PENDIENTE_REVISION : EstadoTransaccion.CONFIRMADO),
      notas: dto.notas ?? null,
      esTransferenciaInterna: dto.esTransferenciaInterna ?? dto.tipoTransaccion === TipoTransaccion.TRANSFERENCIA,
      cuentaContraparteId: dto.cuentaContraparteId ?? null,
      tags: dto.tags,
      comercioCanonico: dto.comercioCanonico,
    };
    return this.prisma.$transaction((tx) => this.insertar(tx, datos, ownerUserId));
  }

  /**
   * Iteración 2 — Fase 4: Crea un par de transacciones enlazadas (`salida` en cuentaOrigenId y `entrada` en cuentaDestinoId)
   * marcadas con `es_transferencia_interna = true` y vinculadas por `transaccion_espejo_id`.
   * Ambas cuentas ven actualizado su saldo atómicamente vía Trigger 2 y el movimiento es 100% neutro en Ingresos/Gastos del mes.
   */
  async crearTransferenciaEntreCuentasPropias(
    dto: CrearTransferenciaInternaDto,
    ownerUserId: bigint,
  ): Promise<ResultadoTransferenciaPropia> {
    if (dto.cuentaOrigenId === dto.cuentaDestinoId) {
      throw datosInvalidos({
        cuentaDestinoId: ['La cuenta de origen y la cuenta de destino deben ser distintas en una transferencia entre cuentas propias'],
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await assertCuenta(tx, dto.cuentaOrigenId, ownerUserId);
      await assertCuenta(tx, dto.cuentaDestinoId, ownerUserId);

      const [origen, destino] = await Promise.all([
        tx.cuentasFinancieras.findUnique({ where: { id: BigInt(dto.cuentaOrigenId) }, select: { nombre: true } }),
        tx.cuentasFinancieras.findUnique({ where: { id: BigInt(dto.cuentaDestinoId) }, select: { nombre: true } }),
      ]);

      const fecha = dto.fechaTransaccion ? new Date(dto.fechaTransaccion) : new Date();
      const moneda = (dto.monedaOriginal ?? 'COP').toUpperCase();
      const conceptoBase =
        dto.concepto?.trim() ||
        `Transferencia entre mis cuentas: ${origen?.nombre ?? `#${dto.cuentaOrigenId}`} → ${destino?.nombre ?? `#${dto.cuentaDestinoId}`}`;

      const salidaInicial = await this.insertar(
        tx,
        {
          tipoTransaccion: TipoTransaccion.EGRESO,
          cuentaOrigenId: dto.cuentaOrigenId,
          cuentaDestinoId: null,
          tarjetaPagadaId: null,
          categoriaId: null,
          fechaTransaccion: fecha,
          concepto: conceptoBase.slice(0, 255),
          monedaOriginal: moneda,
          montoOriginal: dto.monto,
          tasaCambio: dto.tasaCambio,
          origenRegistro: OrigenRegistro.MANUAL,
          estado: EstadoTransaccion.CONFIRMADO,
          notas: dto.notas ?? null,
          esTransferenciaInterna: true,
          cuentaContraparteId: dto.cuentaDestinoId,
          tags: dto.tags,
        },
        ownerUserId,
      );

      const entrada = await this.insertar(
        tx,
        {
          tipoTransaccion: TipoTransaccion.INGRESO,
          cuentaOrigenId: null,
          cuentaDestinoId: dto.cuentaDestinoId,
          tarjetaPagadaId: null,
          categoriaId: null,
          fechaTransaccion: fecha,
          concepto: conceptoBase.slice(0, 255),
          monedaOriginal: moneda,
          montoOriginal: dto.monto,
          tasaCambio: dto.tasaCambio,
          origenRegistro: OrigenRegistro.MANUAL,
          estado: EstadoTransaccion.CONFIRMADO,
          notas: dto.notas ?? null,
          esTransferenciaInterna: true,
          cuentaContraparteId: dto.cuentaOrigenId,
          transaccionEspejoId: Number(salidaInicial.id),
          tags: dto.tags,
        },
        ownerUserId,
      );

      const salida = await tx.transacciones.update({
        where: { id: salidaInicial.id },
        data: { transaccion_espejo_id: entrada.id },
      });

      let comision: Transacciones | null = null;
      if (dto.comisionGMF !== undefined && dto.comisionGMF !== null && toDecimal(dto.comisionGMF).greaterThan(0)) {
        comision = await this.insertar(
          tx,
          {
            tipoTransaccion: TipoTransaccion.EGRESO,
            cuentaOrigenId: dto.cuentaOrigenId,
            cuentaDestinoId: null,
            tarjetaPagadaId: null,
            categoriaId: dto.categoriaComisionId ?? null,
            fechaTransaccion: fecha,
            concepto: `GMF 4x1000 / Comisión · ${conceptoBase}`.slice(0, 255),
            monedaOriginal: moneda,
            montoOriginal: dto.comisionGMF,
            tasaCambio: dto.tasaCambio,
            origenRegistro: OrigenRegistro.MANUAL,
            estado: EstadoTransaccion.CONFIRMADO,
            notas: `Comisión bancaria asociada a transferencia interna #${salida.id}`,
            esTransferenciaInterna: false,
          },
          ownerUserId,
        );
      }

      return { salida, entrada, comision };
    });
  }

  /** Inserción reutilizable (ingesta de correos, pagos recurrentes) dentro de una transacción existente. */
  async insertar(
    tx: Tx,
    datos: DatosTransaccion,
    ownerUserId: bigint,
    opciones: OpcionesInsercion = {},
  ): Promise<Transacciones> {
    await this.validarYResolverReferencias(tx, datos, ownerUserId, opciones);
    const { montoOriginal, tasa, montoCop } = this.resolverMontos(datos);

    const inferido = inferirComercioYTags(`${datos.concepto ?? ''} ${datos.notas ?? ''}`);
    const tagsResueltos = datos.tags !== undefined ? normalizarTags(datos.tags) : normalizarTags(inferido.tags);
    const comercioResuelto =
      datos.comercioCanonico !== undefined ? (datos.comercioCanonico?.trim() || null) : inferido.comercioCanonico;

    if (tagsResueltos.length > 0) {
      await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsResueltos);
    }

    return tx.transacciones.create({
      data: {
        owner_user_id: ownerUserId,
        tipo_transaccion: datos.tipoTransaccion,
        cuenta_origen_id: datos.cuentaOrigenId === null ? null : BigInt(datos.cuentaOrigenId),
        cuenta_destino_id: datos.cuentaDestinoId === null ? null : BigInt(datos.cuentaDestinoId),
        tarjeta_pagada_id: datos.tarjetaPagadaId === null ? null : BigInt(datos.tarjetaPagadaId),
        categoria_id: datos.categoriaId === null ? null : BigInt(datos.categoriaId),
        fecha_transaccion: datos.fechaTransaccion,
        concepto: datos.concepto,
        moneda_original: datos.monedaOriginal,
        monto_original: toDbMoney(montoOriginal),
        tasa_cambio: toDbRate(tasa),
        monto_cop: toDbMoney(montoCop),
        origen_registro: datos.origenRegistro,
        estado: datos.estado,
        notas: datos.notas,
        es_transferencia_interna: datos.esTransferenciaInterna ?? datos.tipoTransaccion === TipoTransaccion.TRANSFERENCIA,
        cuenta_contraparte_id:
          datos.cuentaContraparteId === undefined || datos.cuentaContraparteId === null
            ? null
            : BigInt(datos.cuentaContraparteId),
        transaccion_espejo_id:
          datos.transaccionEspejoId === undefined || datos.transaccionEspejoId === null
            ? null
            : BigInt(datos.transaccionEspejoId),
        ...(datos.tags !== undefined || tagsResueltos.length > 0 ? { tags: tagsResueltos } : {}),
        ...(datos.comercioCanonico !== undefined || comercioResuelto !== null ? { comercio_canonico: comercioResuelto } : {}),
      },
    });
  }

  async update(id: number, dto: UpdateTransaccionDto, ownerUserId: bigint): Promise<Transacciones> {
    return this.prisma.$transaction(async (tx) => {
      const actual = await tx.transacciones.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Transacción ${id} no encontrada`);

      const fusion: DatosTransaccion = {
        tipoTransaccion: dto.tipoTransaccion ?? (actual.tipo_transaccion as TipoTransaccion),
        cuentaOrigenId: dto.cuentaOrigenId !== undefined ? dto.cuentaOrigenId : this.num(actual.cuenta_origen_id),
        cuentaDestinoId: dto.cuentaDestinoId !== undefined ? dto.cuentaDestinoId : this.num(actual.cuenta_destino_id),
        tarjetaPagadaId: dto.tarjetaPagadaId !== undefined ? dto.tarjetaPagadaId : this.num(actual.tarjeta_pagada_id),
        categoriaId: dto.categoriaId !== undefined ? dto.categoriaId : this.num(actual.categoria_id),
        fechaTransaccion: dto.fechaTransaccion ? new Date(dto.fechaTransaccion) : actual.fecha_transaccion,
        concepto: dto.concepto ?? actual.concepto,
        monedaOriginal: actual.moneda_original,
        montoOriginal: dto.montoOriginal ?? actual.monto_original.toString(),
        tasaCambio: dto.tasaCambio ?? actual.tasa_cambio.toString(),
        // Si cambió el monto o la tasa y no se envió monto COP, se recalcula; si no, se conserva.
        montoCop:
          dto.montoCop ??
          (dto.montoOriginal !== undefined || dto.tasaCambio !== undefined ? undefined : actual.monto_cop.toString()),
        origenRegistro: (actual.origen_registro as OrigenRegistro | null) ?? OrigenRegistro.MANUAL,
        estado: dto.estado ?? (actual.estado as EstadoTransaccion | null) ?? EstadoTransaccion.CONFIRMADO,
        notas: dto.notas ?? actual.notas,
      };

      await this.validarYResolverReferencias(tx, fusion, ownerUserId);
      const { montoOriginal, tasa, montoCop } = this.resolverMontos(fusion);

      let tagsActualizar: string[] | undefined;
      if (dto.tags !== undefined) {
        tagsActualizar = normalizarTags(dto.tags);
        await this.sincronizarCatalogoEtiquetasTx(tx, ownerUserId, tagsActualizar);
      }

      const actualizada = await tx.transacciones.update({
        where: { id: actual.id },
        data: {
          tipo_transaccion: fusion.tipoTransaccion,
          cuenta_origen_id: fusion.cuentaOrigenId === null ? null : BigInt(fusion.cuentaOrigenId),
          cuenta_destino_id: fusion.cuentaDestinoId === null ? null : BigInt(fusion.cuentaDestinoId),
          tarjeta_pagada_id: fusion.tarjetaPagadaId === null ? null : BigInt(fusion.tarjetaPagadaId),
          categoria_id: fusion.categoriaId === null ? null : BigInt(fusion.categoriaId),
          fecha_transaccion: fusion.fechaTransaccion,
          concepto: fusion.concepto,
          monto_original: toDbMoney(montoOriginal),
          tasa_cambio: toDbRate(tasa),
          monto_cop: toDbMoney(montoCop),
          estado: fusion.estado,
          notas: fusion.notas,
          ...(tagsActualizar !== undefined ? { tags: tagsActualizar } : {}),
          ...(dto.comercioCanonico !== undefined ? { comercio_canonico: dto.comercioCanonico?.trim() || null } : {}),
        },
      });

      // Mantener simetría contable con su transacción espejo si es transferencia entre cuentas propias
      if (actual.transaccion_espejo_id !== null && actual.transaccion_espejo_id !== undefined) {
        const espejo = await tx.transacciones.findFirst({
          where: { id: actual.transaccion_espejo_id, owner_user_id: ownerUserId },
        });
        if (espejo) {
          await tx.transacciones.update({
            where: { id: espejo.id },
            data: {
              fecha_transaccion: fusion.fechaTransaccion,
              concepto: fusion.concepto,
              monto_original: toDbMoney(montoOriginal),
              tasa_cambio: toDbRate(tasa),
              monto_cop: toDbMoney(montoCop),
              estado: fusion.estado,
              notas: fusion.notas,
              ...(tagsActualizar !== undefined ? { tags: tagsActualizar } : {}),
              ...(dto.comercioCanonico !== undefined ? { comercio_canonico: dto.comercioCanonico?.trim() || null } : {}),
            },
          });
        }
      }

      return actualizada;
    });
  }

  /** "Eliminar" = anular: el Trigger 2 revierte el saldo y se conserva la auditoría (FKs desde el sub-ledger). */
  async anular(id: number, ownerUserId: bigint): Promise<Transacciones> {
    const actual = await this.get(id, ownerUserId);
    if (actual.transaccion_espejo_id !== null && actual.transaccion_espejo_id !== undefined) {
      return this.prisma.$transaction(async (tx) => {
        const anulada = await tx.transacciones.update({
          where: { id: actual.id },
          data: { estado: EstadoTransaccion.ANULADO },
        });
        await tx.transacciones.updateMany({
          where: { id: actual.transaccion_espejo_id!, owner_user_id: ownerUserId },
          data: { estado: EstadoTransaccion.ANULADO },
        });
        return anulada;
      });
    }
    return this.prisma.transacciones.update({ where: { id: actual.id }, data: { estado: EstadoTransaccion.ANULADO } });
  }

  // ───────────────────────────── inteligencia de transferencias (Iteración 3 · Fase 5) ─────────────────────────────

  /**
   * Analiza las transacciones del usuario, extrae llave/cuenta/nombre/entidad, resuelve la persona
   * (por catálogo o por alias aprendidos) y persiste los metadatos (sql/018). Aprende alias nuevos:
   * si una transferencia trae nombre + cuenta/llave de una persona, esa cuenta/llave queda suya.
   */
  async analizarPatronesTransferencias(ownerUserId: bigint) {
    const [transacciones, personas, alias] = await Promise.all([
      this.prisma.transacciones.findMany({ where: { owner_user_id: ownerUserId }, orderBy: { id: 'asc' } }),
      this.prisma.personas.findMany({ where: { owner_user_id: ownerUserId } }),
      this.prisma.aliasIdentificadoresPersona.findMany({ where: { usuario_id: ownerUserId } }),
    ]);
    const aliasPorValor = new Map<string, bigint>();
    for (const a of alias) aliasPorValor.set(a.valor_identificador.toLowerCase(), a.persona_id);

    let actualizadas = 0;
    let conPersona = 0;
    let aliasCreados = 0;
    for (const t of transacciones) {
      if (t.estado === EstadoTransaccion.ANULADO) continue;
      const identidad = extraerIdentidadTransferencia(`${t.concepto} ${t.notas ?? ''} ${t.comercio_canonico ?? ''}`);
      const esTransferencia = t.tipo_transaccion === TipoTransaccion.TRANSFERENCIA || identidad.esTransferencia;
      if (!esTransferencia && !t.es_transferencia) continue;

      let personaId: bigint | null = t.persona_asociada_id ?? null;
      if (!personaId) {
        const porNombre = encontrarPersona(personas, identidad.nombreDestinatario, identidad.llave ?? identidad.celular);
        if (porNombre) personaId = porNombre.id;
      }
      if (!personaId) {
        for (const valor of [identidad.llave, identidad.celular, identidad.cuentaDestino]) {
          const hit = valor ? aliasPorValor.get(valor.toLowerCase()) : undefined;
          if (hit) { personaId = hit; break; }
        }
      }
      if (personaId) conPersona++;

      const datos = {
        es_transferencia: esTransferencia,
        destinatario_nombre_normalizado: identidad.nombreNormalizado ?? t.destinatario_nombre_normalizado,
        llave_o_identificador: identidad.llave ?? identidad.celular ?? t.llave_o_identificador,
        cuenta_bancaria_destino: identidad.cuentaDestino ?? t.cuenta_bancaria_destino,
        entidad_destino: identidad.entidad ?? t.entidad_destino,
        persona_asociada_id: personaId,
      };
      const cambia =
        datos.es_transferencia !== t.es_transferencia ||
        datos.destinatario_nombre_normalizado !== t.destinatario_nombre_normalizado ||
        datos.llave_o_identificador !== t.llave_o_identificador ||
        datos.cuenta_bancaria_destino !== t.cuenta_bancaria_destino ||
        datos.entidad_destino !== t.entidad_destino ||
        String(datos.persona_asociada_id ?? '') !== String(t.persona_asociada_id ?? '');
      if (cambia) {
        await this.prisma.transacciones.update({ where: { id: t.id }, data: datos });
        actualizadas++;
      }

      // Aprendizaje: nombre + identificador de una persona ⇒ el identificador es suyo.
      if (personaId && identidad.nombreNormalizado) {
        for (const [tipo, valor] of [['LLAVE', datos.llave_o_identificador], ['CUENTA', datos.cuenta_bancaria_destino], ['CELULAR', identidad.celular]] as const) {
          if (!valor) continue;
          const clave = valor.toLowerCase();
          if (aliasPorValor.has(clave)) continue;
          aliasPorValor.set(clave, personaId);
          await this.prisma.aliasIdentificadoresPersona.upsert({
            where: { usuario_id_tipo_identificador_valor_identificador: { usuario_id: ownerUserId, tipo_identificador: tipo, valor_identificador: valor } },
            create: { usuario_id: ownerUserId, persona_id: personaId, tipo_identificador: tipo, valor_identificador: valor, entidad_bancaria: datos.entidad_destino, confianza: toDbRate(toDecimal('0.9')) },
            update: {},
          });
          aliasCreados++;
        }
      }
    }
    return { analizadas: transacciones.length, actualizadas, conPersona, aliasCreados };
  }

  /** Analítica agrupada por destinatario, llave y cuenta, con serie mensual y distribución por entidad. */
  async analiticaTransferencias(ownerUserId: bigint, busqueda?: string) {
    const [transacciones, personas] = await Promise.all([
      this.prisma.transacciones.findMany({ where: { owner_user_id: ownerUserId }, orderBy: [{ fecha_transaccion: 'asc' }, { id: 'asc' }] }),
      this.prisma.personas.findMany({ where: { owner_user_id: ownerUserId } }),
    ]);
    const nombrePersona = new Map(personas.map((p) => [String(p.id), p.nombre ?? null]));
    const movimientos: MovimientoTransferencia[] = [];
    for (const t of transacciones) {
      if (t.estado === EstadoTransaccion.ANULADO) continue;
      const identidad = extraerIdentidadTransferencia(`${t.concepto} ${t.notas ?? ''} ${t.comercio_canonico ?? ''}`);
      const esTransferencia = t.es_transferencia || t.tipo_transaccion === TipoTransaccion.TRANSFERENCIA || identidad.esTransferencia;
      if (!esTransferencia) continue;
      // Si aún no se analizó, la persona se resuelve al vuelo por nombre/llave contra el catálogo.
      const resuelta = t.persona_asociada_id ? null : encontrarPersona(personas, identidad.nombreDestinatario, identidad.llave ?? identidad.celular);
      const personaId = t.persona_asociada_id ? Number(t.persona_asociada_id) : resuelta ? Number(resuelta.id) : null;
      movimientos.push({
        id: Number(t.id),
        tipo: t.tipo_transaccion,
        monto: t.monto_cop,
        fecha: t.fecha_transaccion.toISOString().slice(0, 10),
        nombreNormalizado: t.destinatario_nombre_normalizado ?? identidad.nombreNormalizado,
        llave: t.llave_o_identificador ?? identidad.llave ?? identidad.celular,
        cuentaDestino: t.cuenta_bancaria_destino ?? identidad.cuentaDestino,
        entidad: t.entidad_destino ?? identidad.entidad,
        personaId,
        personaNombre: personaId !== null ? (nombrePersona.get(String(personaId)) ?? null) : null,
      });
    }
    const q = busqueda ? sinMayusculas(busqueda) : '';
    const filtrados = q
      ? movimientos.filter((m) => sinMayusculas(`${m.personaNombre ?? ''} ${m.nombreNormalizado ?? ''} ${m.llave ?? ''} ${m.cuentaDestino ?? ''} ${m.entidad ?? ''}`).includes(q))
      : movimientos;

    const porDestinatario = agruparPorDestinatario(filtrados);
    const gruposSimples = (claveDe: (m: MovimientoTransferencia) => string | null) => {
      const mapa = new Map<string, MovimientoTransferencia[]>();
      for (const m of filtrados) {
        const k = claveDe(m);
        if (!k) continue;
        mapa.set(k, [...(mapa.get(k) ?? []), m]);
      }
      return [...mapa.entries()]
        .map(([clave, lista]) => ({
          clave,
          totalEnviado: money(lista.filter((x) => x.tipo === 'EGRESO' || x.tipo === 'TRANSFERENCIA').reduce((a, x) => a.plus(toDecimal(x.monto)), toDecimal(0))).toNumber(),
          totalRecibido: money(lista.filter((x) => x.tipo !== 'EGRESO' && x.tipo !== 'TRANSFERENCIA').reduce((a, x) => a.plus(toDecimal(x.monto)), toDecimal(0))).toNumber(),
          cantidadOperaciones: lista.length,
          ultimaFecha: lista.map((x) => x.fecha).sort().at(-1) ?? null,
        }))
        .sort((a, b) => b.totalEnviado + b.totalRecibido - (a.totalEnviado + a.totalRecibido));
    };

    return {
      resumen: {
        cantidadOperaciones: filtrados.length,
        totalEnviado: porDestinatario.reduce((a, g) => a + g.totalEnviado, 0),
        totalRecibido: porDestinatario.reduce((a, g) => a + g.totalRecibido, 0),
        destinatarios: porDestinatario.length,
      },
      porDestinatario,
      porLlave: gruposSimples((m) => m.llave),
      porCuenta: gruposSimples((m) => m.cuentaDestino),
      porEntidad: gruposSimples((m) => m.entidad),
      serieMensual: serieMensualTransferencias(filtrados),
    };
  }

  /** Vincula manualmente una llave/cuenta/celular a una persona y lo aplica a las transacciones que lo traigan. */
  async vincularIdentificadorAPersona(ownerUserId: bigint, dto: { personaId: number; tipoIdentificador: string; valorIdentificador: string; entidadBancaria?: string }) {
    const tipos = ['LLAVE', 'CUENTA', 'CELULAR', 'NOMBRE_BANCO', 'DOCUMENTO'];
    if (!tipos.includes(dto.tipoIdentificador)) throw datosInvalidos({ tipoIdentificador: [`tipoIdentificador debe ser uno de: ${tipos.join(', ')}`] });
    const valor = (dto.valorIdentificador ?? '').trim();
    if (!valor) throw datosInvalidos({ valorIdentificador: ['valorIdentificador es obligatorio'] });
    const persona = await this.prisma.personas.findFirst({ where: { id: BigInt(dto.personaId), owner_user_id: ownerUserId } });
    if (!persona) throw new NotFoundException(`Persona ${dto.personaId} no encontrada`);

    const alias = await this.prisma.aliasIdentificadoresPersona.upsert({
      where: { usuario_id_tipo_identificador_valor_identificador: { usuario_id: ownerUserId, tipo_identificador: dto.tipoIdentificador, valor_identificador: valor } },
      create: { usuario_id: ownerUserId, persona_id: persona.id, tipo_identificador: dto.tipoIdentificador, valor_identificador: valor, entidad_bancaria: dto.entidadBancaria ?? null, confianza: toDbRate(toDecimal(1)) },
      update: { persona_id: persona.id },
    });

    const transacciones = await this.prisma.transacciones.findMany({ where: { owner_user_id: ownerUserId } });
    let actualizadas = 0;
    const valorNorm = sinMayusculas(valor);
    for (const t of transacciones) {
      const identidad = extraerIdentidadTransferencia(`${t.concepto} ${t.notas ?? ''} ${t.comercio_canonico ?? ''}`);
      const coincide =
        sinMayusculas(t.llave_o_identificador ?? identidad.llave ?? identidad.celular ?? '') === valorNorm ||
        sinMayusculas(t.cuenta_bancaria_destino ?? identidad.cuentaDestino ?? '') === valorNorm ||
        sinMayusculas(t.destinatario_nombre_normalizado ?? identidad.nombreNormalizado ?? '') === valorNorm ||
        normalizarNombreDestinatario(persona.nombre) === (t.destinatario_nombre_normalizado ?? identidad.nombreNormalizado);
      if (!coincide) continue;
      await this.prisma.transacciones.update({ where: { id: t.id }, data: { persona_asociada_id: persona.id, es_transferencia: true } });
      actualizadas++;
    }
    return { aliasId: Number(alias.id), personaId: dto.personaId, transaccionesActualizadas: actualizadas };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async sincronizarCatalogoEtiquetasTx(tx: Tx, ownerUserId: bigint, slugs: string[]): Promise<void> {
    if (!tx.etiquetas || typeof tx.etiquetas.upsert !== 'function') return;
    for (const slug of slugs) {
      await tx.etiquetas.upsert({
        where: { owner_user_id_slug: { owner_user_id: ownerUserId, slug } },
        create: {
          owner_user_id: ownerUserId,
          slug,
          nombre: nombreLegibleTag(slug),
          color: colorSugeridoTag(slug),
          tipo_agrupacion: 'HABITO',
        },
        update: {},
      });
    }
  }

  private async validarYResolverReferencias(
    tx: Tx,
    datos: DatosTransaccion,
    ownerUserId: bigint,
    opciones: OpcionesInsercion = {},
  ): Promise<void> {
    // Un correo de "pago de tarjeta" a veces solo identifica la cuenta de origen: se admite sin tarjeta_pagada_id.
    const errores = validarReglasTransaccion(datos).filter(
      (e) => !(opciones.permitirPagoTarjetaSinTarjeta && e.startsWith('tarjetaPagadaId es obligatoria')),
    );
    if (errores.length > 0) throw datosInvalidos({ transaccion: errores });

    if (datos.cuentaOrigenId !== null) await assertCuenta(tx, datos.cuentaOrigenId, ownerUserId);
    if (datos.cuentaDestinoId !== null) await assertCuenta(tx, datos.cuentaDestinoId, ownerUserId);
    if (datos.tarjetaPagadaId !== null) await assertTarjeta(tx, datos.tarjetaPagadaId, ownerUserId);
    if (datos.categoriaId !== null) await assertCategoria(tx, datos.categoriaId, ownerUserId);
  }

  /** Monto original, tasa y monto COP con Decimal. COP → tasa 1; otra divisa exige tasa. */
  private resolverMontos(datos: DatosTransaccion) {
    const montoOriginal = money(toDecimal(datos.montoOriginal));
    if (!montoOriginal.greaterThan(0)) throw datosInvalidos({ montoOriginal: ['montoOriginal debe ser mayor a 0'] });

    const esCop = datos.monedaOriginal === 'COP';
    const tasaDada = datos.tasaCambio === undefined || datos.tasaCambio === null ? null : rate(toDecimal(datos.tasaCambio));
    if (!esCop && (!tasaDada || !tasaDada.greaterThan(0))) {
      throw datosInvalidos({ tasaCambio: [`tasaCambio es obligatoria para ${datos.monedaOriginal}`] });
    }
    const tasa = esCop ? toDecimal(1) : (tasaDada as ReturnType<typeof toDecimal>);
    const montoCop =
      datos.montoCop === undefined || datos.montoCop === null ? money(montoOriginal.mul(tasa)) : money(toDecimal(datos.montoCop));
    if (!montoCop.greaterThan(0)) throw datosInvalidos({ montoCop: ['montoCop debe ser mayor a 0'] });
    return { montoOriginal, tasa, montoCop };
  }

  private num(value: bigint | null): number | null {
    return value === null ? null : Number(value);
  }

  /** Mes completo en hora local de Bogotá (UTC-5), como se registran los movimientos. */
  private rangoDelPeriodo(periodo: string): { desde: string; hasta: string } {
    const [y, m] = periodo.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { desde: `${periodo}-01T00:00:00-05:00`, hasta: `${periodo}-${String(ultimo).padStart(2, '0')}T23:59:59.999-05:00` };
  }

  private finDeDia(valor: string): Date {
    return valor.length === 10 ? new Date(`${valor}T23:59:59.999Z`) : new Date(valor);
  }
}

/** Texto comparable sin tildes ni mayúsculas (búsqueda de la analítica de transferencias). */
function sinMayusculas(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface OpcionesInsercion {
  /** Solo para la ingesta automática de correos: permite PAGO_TARJETA sin `tarjeta_pagada_id`. */
  permitirPagoTarjetaSinTarjeta?: boolean;
}
