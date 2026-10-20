import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '../../config/decimal.config';
import {
  EstadoPeriodoRecurrente,
  EstadoTransaccion,
  FrecuenciaRecurrente,
  OrigenRegistro,
  TipoTransaccion,
} from '../../common/enums/finance.enums';
import { isValidPeriodo } from '../../common/utils/date.util';
import { money, rate, sumDecimals, toDb, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import {
  assertCategoria,
  assertCuenta,
  assertPeriodoRecurrente,
  assertPersona,
  assertPrestamo,
  assertTarjeta,
} from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizarComercio } from '../notificaciones-correo/comercio.util';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { CargoSerie, detectarCandidatos } from './detector-recurrentes.util';
import {
  CreatePlantillaRecurrenteDto,
  RegistrarPagoPeriodoDto,
  ResponsableRecurrenteDto,
  UpdatePlantillaRecurrenteDto,
} from './dto/recurrente.dto';

type Tx = Prisma.TransactionClient;

/** Valida el reparto: cada fila con porcentaje o monto fijo; Σ porcentajes ≤ 100 (Decimal). */
export function validarReparto(responsables: ResponsableRecurrenteDto[]): string[] {
  const errores: string[] = [];
  responsables.forEach((r, i) => {
    if (r.porcentajeParticipacion === undefined && r.montoFijoParticipacion === undefined) {
      errores.push(`responsables[${i}]: indica porcentajeParticipacion o montoFijoParticipacion`);
    }
  });
  const total = sumDecimals(responsables.map((r) => r.porcentajeParticipacion));
  if (total.greaterThan(100)) errores.push(`La suma de porcentajes (${total.toString()}) no puede superar 100`);
  return errores;
}

@Injectable()
export class GastosRecurrentesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transacciones: TransaccionesService,
  ) {}

  // ───────────────────────────── Plantillas ─────────────────────────────

  listPlantillas(ownerUserId: bigint, soloActivas = false) {
    return this.prisma.plantillasRecurrentes.findMany({
      where: { owner_user_id: ownerUserId, ...(soloActivas ? { is_active: true } : {}) },
      include: { responsables: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
  }

  async getPlantilla(id: number, ownerUserId: bigint) {
    const plantilla = await this.prisma.plantillasRecurrentes.findFirst({
      where: { id: BigInt(id), owner_user_id: ownerUserId },
      include: { responsables: { include: { persona: { select: { id: true, nombre: true } } }, orderBy: { id: 'asc' } } },
    });
    if (!plantilla) throw new NotFoundException(`Plantilla recurrente ${id} no encontrada`);
    return plantilla;
  }

  async createPlantilla(dto: CreatePlantillaRecurrenteDto, ownerUserId: bigint) {
    if (dto.responsables) this.exigirRepartoValido(dto.responsables);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.validarReferencias(tx, dto, ownerUserId);
      const plantilla = await tx.plantillasRecurrentes.create({
        data: {
          owner_user_id: ownerUserId,
          nombre: dto.nombre,
          categoria_id: dto.categoriaId === undefined ? null : BigInt(dto.categoriaId),
          frecuencia: dto.frecuencia ?? FrecuenciaRecurrente.MENSUAL,
          dia_vencimiento_estimado: dto.diaVencimientoEstimado ?? null,
          es_monto_variable: dto.esMontoVariable ?? false,
          moneda: (dto.moneda ?? 'COP').toUpperCase(),
          monto_base_estimado: toDbMoney(toDecimal(dto.montoBaseEstimado)),
          cuenta_debito_default_id: dto.cuentaDebitoDefaultId === undefined ? null : BigInt(dto.cuentaDebitoDefaultId),
          tarjeta_credito_default_id: dto.tarjetaCreditoDefaultId === undefined ? null : BigInt(dto.tarjetaCreditoDefaultId),
          prestamo_asociado_id: dto.prestamoAsociadoId === undefined ? null : BigInt(dto.prestamoAsociadoId),
          is_active: dto.isActive ?? true,
        },
      });
      if (dto.responsables?.length) await this.reemplazarResponsables(tx, plantilla.id, dto.responsables, ownerUserId);
      return plantilla.id;
    });
    return this.getPlantilla(Number(id), ownerUserId);
  }

  async updatePlantilla(id: number, dto: UpdatePlantillaRecurrenteDto, ownerUserId: bigint) {
    if (dto.responsables) this.exigirRepartoValido(dto.responsables);
    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.plantillasRecurrentes.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
      if (!actual) throw new NotFoundException(`Plantilla recurrente ${id} no encontrada`);
      await this.validarReferencias(tx, dto, ownerUserId);

      const data: Prisma.PlantillasRecurrentesUncheckedUpdateInput = {};
      if (dto.nombre !== undefined) data.nombre = dto.nombre;
      if (dto.categoriaId !== undefined) data.categoria_id = dto.categoriaId === null ? null : BigInt(dto.categoriaId);
      if (dto.frecuencia !== undefined) data.frecuencia = dto.frecuencia;
      if (dto.diaVencimientoEstimado !== undefined) data.dia_vencimiento_estimado = dto.diaVencimientoEstimado;
      if (dto.esMontoVariable !== undefined) data.es_monto_variable = dto.esMontoVariable;
      if (dto.montoBaseEstimado !== undefined) data.monto_base_estimado = toDbMoney(toDecimal(dto.montoBaseEstimado));
      if (dto.cuentaDebitoDefaultId !== undefined) {
        data.cuenta_debito_default_id = dto.cuentaDebitoDefaultId === null ? null : BigInt(dto.cuentaDebitoDefaultId);
      }
      if (dto.tarjetaCreditoDefaultId !== undefined) {
        data.tarjeta_credito_default_id = dto.tarjetaCreditoDefaultId === null ? null : BigInt(dto.tarjetaCreditoDefaultId);
      }
      if (dto.prestamoAsociadoId !== undefined) {
        data.prestamo_asociado_id = dto.prestamoAsociadoId === null ? null : BigInt(dto.prestamoAsociadoId);
      }
      if (dto.isActive !== undefined) data.is_active = dto.isActive;
      if (Object.keys(data).length > 0) await tx.plantillasRecurrentes.update({ where: { id: actual.id }, data });
      if (dto.responsables) await this.reemplazarResponsables(tx, actual.id, dto.responsables, ownerUserId);
    });
    return this.getPlantilla(id, ownerUserId);
  }

  /** Sin periodos generados se elimina; con historial se desactiva (`is_active=false`) para no perder el pronóstico. */
  async removePlantilla(id: number, ownerUserId: bigint): Promise<{ eliminada: boolean; desactivada: boolean }> {
    const plantilla = await this.getPlantilla(id, ownerUserId);
    const periodos = await this.prisma.periodosRecurrentes.count({ where: { plantilla_recurrente_id: plantilla.id } });
    if (periodos > 0) {
      await this.prisma.plantillasRecurrentes.update({ where: { id: plantilla.id }, data: { is_active: false } });
      return { eliminada: false, desactivada: true };
    }
    await this.prisma.$transaction([
      this.prisma.responsablesRecurrentes.deleteMany({ where: { plantilla_recurrente_id: plantilla.id } }),
      this.prisma.plantillasRecurrentes.delete({ where: { id: plantilla.id } }),
    ]);
    return { eliminada: true, desactivada: false };
  }

  // ───────────────────────────── Periodos ─────────────────────────────

  listPeriodos(ownerUserId: bigint, periodo?: string, estado?: string) {
    return this.prisma.periodosRecurrentes.findMany({
      where: {
        owner_user_id: ownerUserId,
        ...(periodo ? { periodo } : {}),
        ...(estado ? { estado } : {}),
      },
      include: { plantilla: { select: { id: true, nombre: true, es_monto_variable: true } } },
      orderBy: [{ periodo: 'desc' }, { fecha_estimada_pago: 'asc' }],
    });
  }

  /**
   * Proyección del mes (sección 6.2.C): monto variable = promedio móvil de los últimos 3 periodos con pago real;
   * fijo = `monto_base_estimado`. Idempotente (`ON CONFLICT (plantilla_recurrente_id, periodo) DO NOTHING`).
   */
  async proyectar(periodo: string, ownerUserId: bigint) {
    if (!isValidPeriodo(periodo)) throw datosInvalidos({ periodo: ['periodo debe tener formato YYYY-MM'] });

    const generados = await this.prisma.$executeRaw`
      INSERT INTO "PeriodosRecurrentes" (
        plantilla_recurrente_id, owner_user_id, periodo, fecha_estimada_pago, monto_pronosticado, estado
      )
      SELECT
        pl.id,
        pl.owner_user_id,
        ${periodo}::char(7),
        make_date(
          SPLIT_PART(${periodo}::text, '-', 1)::int,
          SPLIT_PART(${periodo}::text, '-', 2)::int,
          LEAST(COALESCE(pl.dia_vencimiento_estimado, 15), 28)
        ),
        CASE
          WHEN pl.es_monto_variable = true THEN COALESCE((
            SELECT ROUND(AVG(pr_hist.monto_real_pagado)::numeric, 2)
            FROM (
              SELECT monto_real_pagado
              FROM "PeriodosRecurrentes"
              WHERE plantilla_recurrente_id = pl.id
                AND monto_real_pagado IS NOT NULL
              ORDER BY periodo DESC
              LIMIT 3
            ) pr_hist
          ), pl.monto_base_estimado)
          ELSE pl.monto_base_estimado
        END AS monto_pronosticado,
        'PROYECTADO'
      FROM "PlantillasRecurrentes" pl
      WHERE pl.owner_user_id = ${ownerUserId}::int8
        AND pl.is_active = true
      ON CONFLICT (plantilla_recurrente_id, periodo) DO NOTHING`;

    const periodos = await this.listPeriodos(ownerUserId, periodo);
    return { periodo, generados, total: periodos.length, periodos };
  }

  /**
   * Registra el pago real. En UN solo UPDATE se fijan `monto_real_pagado` y `estado` para que el Trigger 7
   * (`trg_after_update_periodo_recurrente`) calcule la parte de cada participante con el monto real.
   */
  async registrarPago(id: number, dto: RegistrarPagoPeriodoDto, ownerUserId: bigint) {
    const montoReal = money(toDecimal(dto.montoRealPagado));
    if (!montoReal.greaterThan(0)) throw datosInvalidos({ montoRealPagado: ['montoRealPagado debe ser mayor a 0'] });
    const estado = dto.estado ?? EstadoPeriodoRecurrente.PAGADO;
    if (estado !== EstadoPeriodoRecurrente.PAGADO && estado !== EstadoPeriodoRecurrente.FACTURADO) {
      throw datosInvalidos({ estado: ['estado debe ser PAGADO o FACTURADO'] });
    }

    await this.prisma.$transaction(async (tx) => {
      const periodo = await assertPeriodoRecurrente(tx, id, ownerUserId);
      if (periodo.estado === EstadoPeriodoRecurrente.OMITIDO) {
        throw new ConflictException('El periodo está OMITIDO; no admite pagos');
      }
      const plantilla = await tx.plantillasRecurrentes.findUniqueOrThrow({ where: { id: periodo.plantilla_recurrente_id } });

      let transaccionPagoId: bigint | null = periodo.transaccion_pago_id;
      if (dto.transaccionPagoId !== undefined) {
        const existente = await tx.transacciones.findFirst({
          where: { id: BigInt(dto.transaccionPagoId), owner_user_id: ownerUserId },
          select: { id: true },
        });
        if (!existente) throw new NotFoundException(`Transacción ${dto.transaccionPagoId} no encontrada`);
        transaccionPagoId = existente.id;
      } else if (dto.crearTransaccion) {
        const cuentaId = dto.cuentaOrigenId ?? (plantilla.cuenta_debito_default_id ? Number(plantilla.cuenta_debito_default_id) : null);
        if (cuentaId === null) {
          throw datosInvalidos({ cuentaOrigenId: ['cuentaOrigenId es obligatoria (la plantilla no tiene cuenta de débito)'] });
        }
        const creada = await this.transacciones.insertar(
          tx,
          {
            tipoTransaccion: TipoTransaccion.EGRESO,
            cuentaOrigenId: cuentaId,
            cuentaDestinoId: null,
            tarjetaPagadaId: null,
            categoriaId: plantilla.categoria_id === null ? null : Number(plantilla.categoria_id),
            fechaTransaccion: new Date(),
            concepto: `${plantilla.nombre} (${periodo.periodo})`.slice(0, 255),
            monedaOriginal: 'COP',
            montoOriginal: montoReal.toString(),
            origenRegistro: OrigenRegistro.MANUAL,
            estado: EstadoTransaccion.CONFIRMADO,
            notas: `Pago del periodo recurrente ${periodo.id}`,
          },
          ownerUserId,
        );
        transaccionPagoId = creada.id;
      }

      let compraPagoId: bigint | null = periodo.compra_credito_pago_id;
      if (dto.compraCreditoPagoId !== undefined) {
        const compra = await tx.comprasCredito.findFirst({
          where: { id: BigInt(dto.compraCreditoPagoId), owner_user_id: ownerUserId },
          select: { id: true },
        });
        if (!compra) throw new NotFoundException(`Compra ${dto.compraCreditoPagoId} no encontrada`);
        compraPagoId = compra.id;
      }

      await tx.periodosRecurrentes.update({
        where: { id: periodo.id },
        data: {
          monto_real_pagado: toDbMoney(montoReal),
          estado,
          transaccion_pago_id: transaccionPagoId,
          compra_credito_pago_id: compraPagoId,
        },
      });
    });

    return this.prisma.periodosRecurrentes.findUniqueOrThrow({
      where: { id: BigInt(id) },
      include: { plantilla: { select: { id: true, nombre: true } }, movimientos: true },
    });
  }

  // ───────────────────────────── Radar de suscripciones (Fase 3) ─────────────────────────────

  /**
   * Correlaciona compras a 1 cuota + egresos de los últimos N meses y detecta pagos recurrentes.
   * Cruza contra plantillas y recurrentes-por-persona ya registrados. Sin escrituras.
   */
  async detectarPagosRecurrentesPorCorrelacion(ownerUserId: bigint, mesesVentana = 6) {
    const desde = new Date();
    desde.setUTCMonth(desde.getUTCMonth() - mesesVentana);
    const [compras, transacciones, plantillas, recurrentesPersona] = await Promise.all([
      this.prisma.comprasCredito.findMany({
        where: { owner_user_id: ownerUserId, numero_cuotas: 1, fecha_compra: { gte: desde } },
        select: { concepto: true, comercio_canonico: true, fecha_compra: true, valor_compra: true },
      }),
      this.prisma.transacciones.findMany({
        // Solo EGRESO directo: PAGO_TARJETA excluiría duplicar las compras TC.
        where: { owner_user_id: ownerUserId, tipo_transaccion: TipoTransaccion.EGRESO, estado: { not: EstadoTransaccion.ANULADO }, fecha_transaccion: { gte: desde } },
        select: { concepto: true, comercio_canonico: true, fecha_transaccion: true, monto_cop: true },
      }),
      this.prisma.plantillasRecurrentes.findMany({ where: { owner_user_id: ownerUserId }, select: { nombre: true, is_active: true } }),
      this.prisma.cargosRecurrentesPersona.findMany({ where: { owner_user_id: ownerUserId, activo: true }, select: { concepto: true } }),
    ]);
    const cargos: CargoSerie[] = [
      ...compras.filter((c) => c.fecha_compra).map((c) => ({ fecha: c.fecha_compra as Date, monto: toDecimal(c.valor_compra), descripcion: c.concepto ?? '', comercioCanonico: c.comercio_canonico })),
      ...transacciones.map((t) => ({ fecha: t.fecha_transaccion, monto: toDecimal(t.monto_cop), descripcion: t.concepto ?? '', comercioCanonico: t.comercio_canonico })),
    ];
    const candidatos = detectarCandidatos(cargos);
    const registradas = new Set(plantillas.filter((p) => p.is_active).map((p) => normalizarComercio(p.nombre)));
    const pendientesCancelar = new Set(plantillas.filter((p) => !p.is_active).map((p) => normalizarComercio(p.nombre)));
    const compartidas = new Set(recurrentesPersona.map((r) => normalizarComercio(r.concepto)));

    const enriquecidos = candidatos.map((c) => ({
      ...c,
      montoPromedio: money(c.montoPromedio),
      ultimoMonto: money(c.ultimoMonto),
      montoMensualizado: money(c.montoMensualizado),
      estadoDetectado: pendientesCancelar.has(c.clave)
        ? 'PENDIENTE_CANCELACION'
        : registradas.has(c.clave) || compartidas.has(c.clave)
          ? 'REGISTRADA'
          : 'NUEVA_SUSCRIPCION_DETECTADA',
      alertaProxima: c.proximaFechaEstimada.getTime() - Date.now() <= 5 * 86_400_000 && c.proximaFechaEstimada.getTime() >= Date.now(),
    }));
    const activas = enriquecidos.filter((c) => c.estadoDetectado !== 'PENDIENTE_CANCELACION');
    const mensual = activas.reduce((acc, c) => acc.plus(c.montoMensualizado), new Decimal(0));
    return {
      mesesVentana,
      candidatos: enriquecidos,
      kpis: {
        gastoMensualDetectado: money(mensual),
        impactoAnualProyectado: money(mensual.mul(12)),
        suscripcionesOcultas: enriquecidos.filter((c) => c.estadoDetectado === 'NUEVA_SUSCRIPCION_DETECTADA').length,
        totalDetectadas: enriquecidos.length,
      },
    };
  }

  /**
   * «Marcar para cancelar»: se registra como plantilla inactiva con el nombre del comercio.
   * El radar la reconoce como PENDIENTE_CANCELACION y avisa si vuelve a entrar un cargo.
   */
  async marcarParaCancelar(ownerUserId: bigint, dto: { comercio: string; monto?: number | string; frecuencia?: string }) {
    const nombre = dto.comercio.trim();
    if (!nombre) throw datosInvalidos({ comercio: ['comercio es obligatorio'] });
    const existente = await this.prisma.plantillasRecurrentes.findFirst({ where: { owner_user_id: ownerUserId, nombre } });
    if (existente) {
      await this.prisma.plantillasRecurrentes.update({ where: { id: existente.id }, data: { is_active: false } });
      return { comercio: nombre, estado: 'PENDIENTE_CANCELACION' };
    }
    await this.prisma.plantillasRecurrentes.create({
      data: {
        owner_user_id: ownerUserId,
        nombre,
        frecuencia: dto.frecuencia ?? FrecuenciaRecurrente.MENSUAL,
        monto_base_estimado: toDbMoney(toDecimal(dto.monto ?? 0)),
        is_active: false,
      },
    });
    return { comercio: nombre, estado: 'PENDIENTE_CANCELACION' };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private exigirRepartoValido(responsables: ResponsableRecurrenteDto[]): void {
    const errores = validarReparto(responsables);
    if (errores.length > 0) throw datosInvalidos({ responsables: errores });
  }

  private async validarReferencias(
    tx: Tx,
    dto: {
      categoriaId?: number | null;
      cuentaDebitoDefaultId?: number | null;
      tarjetaCreditoDefaultId?: number | null;
      prestamoAsociadoId?: number | null;
    },
    ownerUserId: bigint,
  ): Promise<void> {
    if (dto.categoriaId) await assertCategoria(tx, dto.categoriaId, ownerUserId);
    if (dto.cuentaDebitoDefaultId) await assertCuenta(tx, dto.cuentaDebitoDefaultId, ownerUserId);
    if (dto.tarjetaCreditoDefaultId) await assertTarjeta(tx, dto.tarjetaCreditoDefaultId, ownerUserId);
    if (dto.prestamoAsociadoId) await assertPrestamo(tx, dto.prestamoAsociadoId, ownerUserId);
  }

  private async reemplazarResponsables(
    tx: Tx,
    plantillaId: bigint,
    responsables: ResponsableRecurrenteDto[],
    ownerUserId: bigint,
  ): Promise<void> {
    for (const r of responsables) {
      if (r.personaId !== undefined) await assertPersona(tx, r.personaId, ownerUserId);
    }
    await tx.responsablesRecurrentes.deleteMany({ where: { plantilla_recurrente_id: plantillaId } });
    if (responsables.length === 0) return;
    await tx.responsablesRecurrentes.createMany({
      data: responsables.map((r) => ({
        plantilla_recurrente_id: plantillaId,
        persona_id: r.personaId === undefined ? null : BigInt(r.personaId),
        porcentaje_participacion:
          r.porcentajeParticipacion === undefined ? null : toDb(rate(toDecimal(r.porcentajeParticipacion))),
        monto_fijo_participacion:
          r.montoFijoParticipacion === undefined ? null : toDbMoney(toDecimal(r.montoFijoParticipacion)),
      })),
    });
  }
}
