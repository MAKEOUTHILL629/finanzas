import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EstadoMovimientoDeuda, TipoMovimientoDeuda } from '../../common/enums/finance.enums';
import { parseIsoDate, periodoOf } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertPersona } from '../../common/utils/ownership.util';
import { Decimal } from '../../config/decimal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { TX_OPTIONS } from '../compras-credito/compras-credito.service';
import { calcularPartes, ModoDivision } from './cobro-division.calc';
import { FiltroCobrosDto, GuardarCobroPuntualDto } from './dto/cobros.dto';

const LEGACY_YO = 'lm1R40P16oHgkM3Szu91du';

type Tx = Prisma.TransactionClient;

const INCLUDE = { participantes: { include: { persona: { select: { id: true, nombre: true, iniciales_nombre: true, color_representativo: true } } }, orderBy: { id: 'asc' } } } satisfies Prisma.CobrosPuntualesInclude;
type CobroConParticipantes = Prisma.CobrosPuntualesGetPayload<{ include: typeof INCLUDE }>;

/**
 * Cobros puntuales: un gasto que se reparte entre varias personas (el recibo de la luz que varía cada mes, el mercado, lo de
 * una fiesta que se paga entre todos…). Cada participante distinto del propietario recibe un cargo `CARGO_COBRO_PUNTUAL` en el
 * sub-ledger, que aparece en su liquidación del periodo; los pagos y el saldo pendiente siguen el flujo normal de abonos.
 */
@Injectable()
export class CobrosPuntualesService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(ownerUserId: bigint, filtro: FiltroCobrosDto = {}) {
    const estado = filtro.estado ?? 'ACTIVO';
    const cobros = await this.prisma.cobrosPuntuales.findMany({
      where: {
        owner_user_id: ownerUserId,
        ...(filtro.periodo ? { periodo_imputacion: filtro.periodo } : {}),
        ...(estado === 'TODOS' ? {} : { estado }),
      },
      include: INCLUDE,
      orderBy: [{ fecha_gasto: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    return cobros.map((c) => this.vista(c));
  }

  async obtener(id: number, ownerUserId: bigint) {
    return this.vista(await this.requerir(this.prisma, id, ownerUserId));
  }

  async crear(dto: GuardarCobroPuntualDto, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const datos = await this.prepararDatos(tx, dto, ownerUserId);
      const cobro = await tx.cobrosPuntuales.create({
        data: {
          owner_user_id: ownerUserId,
          concepto: datos.concepto,
          categoria: datos.categoria,
          fecha_gasto: datos.fecha,
          periodo_imputacion: datos.periodo,
          monto_total: toDbMoney(datos.total),
          modo_division: datos.modo,
          transaccion_id: datos.transaccionId,
          compra_credito_id: datos.compraCreditoId,
          notificacion_id: datos.notificacionId,
          notas: dto.notas?.trim() || null,
          participantes: {
            create: datos.partes.map((p) => ({ persona_id: BigInt(p.personaId), monto: toDbMoney(p.monto), porcentaje: p.porcentaje, es_propio: p.esPropio })),
          },
        },
        include: INCLUDE,
      });
      await this.generarCargos(tx, cobro, ownerUserId);
      return this.vista(cobro);
    }, TX_OPTIONS);
  }

  /** Reemplaza el cobro completo: se rehacen los participantes y sus cargos (los pagos ya hechos no se tocan). */
  async actualizar(id: number, dto: GuardarCobroPuntualDto, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const actual = await this.requerir(tx, id, ownerUserId);
      if (actual.estado === 'ANULADO') throw new ConflictException('El cobro está anulado: no se puede editar');
      const datos = await this.prepararDatos(tx, dto, ownerUserId);

      await tx.movimientosDeudaPersona.deleteMany({ where: { cobro_puntual_id: actual.id } });
      await tx.cobrosPuntualesPersonas.deleteMany({ where: { cobro_id: actual.id } });
      const cobro = await tx.cobrosPuntuales.update({
        where: { id: actual.id },
        data: {
          concepto: datos.concepto,
          categoria: datos.categoria,
          fecha_gasto: datos.fecha,
          periodo_imputacion: datos.periodo,
          monto_total: toDbMoney(datos.total),
          modo_division: datos.modo,
          transaccion_id: datos.transaccionId,
          compra_credito_id: datos.compraCreditoId,
          notificacion_id: datos.notificacionId,
          notas: dto.notas?.trim() || null,
          updated_at: new Date(),
          participantes: {
            create: datos.partes.map((p) => ({ persona_id: BigInt(p.personaId), monto: toDbMoney(p.monto), porcentaje: p.porcentaje, es_propio: p.esPropio })),
          },
        },
        include: INCLUDE,
      });
      await this.generarCargos(tx, cobro, ownerUserId);
      return this.vista(cobro);
    }, TX_OPTIONS);
  }

  /** Anula el cobro: sus cargos quedan ANULADOS (no cuentan en la liquidación) pero se conservan para auditar. */
  async anular(id: number, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const actual = await this.requerir(tx, id, ownerUserId);
      await tx.movimientosDeudaPersona.updateMany({ where: { cobro_puntual_id: actual.id }, data: { estado: EstadoMovimientoDeuda.ANULADO } });
      const cobro = await tx.cobrosPuntuales.update({ where: { id: actual.id }, data: { estado: 'ANULADO', updated_at: new Date() }, include: INCLUDE });
      return this.vista(cobro);
    }, TX_OPTIONS);
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async requerir(db: Tx | PrismaService, id: number, ownerUserId: bigint): Promise<CobroConParticipantes> {
    const cobro = await db.cobrosPuntuales.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, include: INCLUDE });
    if (!cobro) throw new NotFoundException(`Cobro ${id} no encontrado`);
    return cobro;
  }

  private async prepararDatos(tx: Tx, dto: GuardarCobroPuntualDto, ownerUserId: bigint) {
    const fecha = parseIsoDate(dto.fechaGasto);
    if (!fecha) throw datosInvalidos({ fechaGasto: ['fechaGasto debe tener formato yyyy-MM-dd'] });
    const total = money(toDecimal(dto.montoTotal));
    const modo: ModoDivision = dto.modoDivision ?? 'IGUAL';

    for (const p of dto.participantes) await assertPersona(tx, p.personaId, ownerUserId);
    const yo = await tx.personas.findFirst({
      where: { owner_user_id: ownerUserId, OR: [{ linked_user_id: ownerUserId }, { legacy_appsheet_id: LEGACY_YO }] },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const partes = calcularPartes(total, modo, dto.participantes, yo?.id ?? null);

    const [transaccionId, compraCreditoId, notificacionId] = await Promise.all([
      dto.transaccionId === undefined ? null : tx.transacciones.findFirst({ where: { id: BigInt(dto.transaccionId), owner_user_id: ownerUserId }, select: { id: true } }),
      dto.compraCreditoId === undefined ? null : tx.comprasCredito.findFirst({ where: { id: BigInt(dto.compraCreditoId), owner_user_id: ownerUserId }, select: { id: true } }),
      dto.notificacionId === undefined ? null : tx.notificacionesCorreo.findFirst({ where: { id: BigInt(dto.notificacionId), owner_user_id: ownerUserId }, select: { id: true } }),
    ]);
    if (dto.transaccionId !== undefined && !transaccionId) throw datosInvalidos({ transaccionId: ['La transacción no existe'] });
    if (dto.compraCreditoId !== undefined && !compraCreditoId) throw datosInvalidos({ compraCreditoId: ['La compra no existe'] });
    if (dto.notificacionId !== undefined && !notificacionId) throw datosInvalidos({ notificacionId: ['El correo no existe'] });

    return {
      concepto: dto.concepto.trim(),
      categoria: dto.categoria ?? 'OTRO',
      fecha,
      periodo: dto.periodo ?? periodoOf(fecha),
      total,
      modo,
      partes,
      transaccionId: transaccionId?.id ?? null,
      compraCreditoId: compraCreditoId?.id ?? null,
      notificacionId: notificacionId?.id ?? null,
    };
  }

  /** Un cargo por cada participante que no es el propietario y debe algo. */
  private async generarCargos(tx: Tx, cobro: CobroConParticipantes, ownerUserId: bigint): Promise<void> {
    for (const p of cobro.participantes) {
      if (p.es_propio || !toDecimal(p.monto).greaterThan(0)) continue;
      await tx.movimientosDeudaPersona.create({
        data: {
          owner_user_id: ownerUserId,
          persona_id: p.persona_id,
          fecha_movimiento: cobro.fecha_gasto,
          periodo_imputacion: cobro.periodo_imputacion,
          tipo_movimiento: TipoMovimientoDeuda.CARGO_COBRO_PUNTUAL,
          signo: 1,
          monto: p.monto,
          cobro_puntual_id: cobro.id,
          appsheet_row_id: `COBRO_${cobro.id}_P${p.persona_id}`,
          concepto: cobro.concepto.slice(0, 255),
          estado: EstadoMovimientoDeuda.CONFIRMADO,
        },
      });
    }
  }

  private vista(c: CobroConParticipantes) {
    const total = toDecimal(c.monto_total);
    const aCobrar = c.participantes.filter((p) => !p.es_propio).reduce<Decimal>((acc, p) => acc.plus(toDecimal(p.monto)), new Decimal(0));
    return {
      id: c.id,
      concepto: c.concepto,
      categoria: c.categoria,
      fechaGasto: c.fecha_gasto,
      periodo: c.periodo_imputacion,
      montoTotal: total,
      modoDivision: c.modo_division,
      estado: c.estado,
      notas: c.notas,
      transaccionId: c.transaccion_id,
      compraCreditoId: c.compra_credito_id,
      notificacionId: c.notificacion_id,
      montoACobrar: money(aCobrar),
      parteDelPropietario: money(total.minus(aCobrar)),
      participantes: c.participantes.map((p) => ({
        personaId: p.persona_id,
        nombre: p.persona.nombre,
        iniciales: p.persona.iniciales_nombre,
        color: p.persona.color_representativo,
        monto: toDecimal(p.monto),
        porcentaje: p.porcentaje === null ? null : toDecimal(p.porcentaje),
        esPropio: p.es_propio,
      })),
    };
  }
}
