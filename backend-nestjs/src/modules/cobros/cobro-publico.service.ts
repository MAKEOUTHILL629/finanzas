import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { Decimal } from '../../config/decimal.config';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { LimiteTasa } from '../../common/utils/rate-limit.util';
import { PrismaService } from '../../prisma/prisma.service';
import { asegurarClaves } from './ajustes-cobro.util';
import { validarComprobante } from './comprobante.util';
import { ReportarPagoDto } from './dto/cobros.dto';
import { ObjetarCobroDto } from './dto/cobros-fase6.dto';
import { SnapshotCobro } from './enlaces-cobro.service';
import { MetodosPagoService } from './metodos-pago.service';
import { ObjecionesCobroService } from './objeciones-cobro.service';

const MAX_PENDIENTES_POR_ENLACE = 8;
const MAX_MONTO = 1_000_000_000;
const VENTANA_FECHA_PAGO_DIAS = 120;

/** Mismo mensaje para «no existe», «revocado» y «vencido»: quien adivina un token no aprende nada. */
const ENLACE_INVALIDO = 'Este enlace no es válido o ya venció. Pídele a quien te lo envió que te comparta uno nuevo.';

/**
 * Lado público de los enlaces de cobro: la persona abre su enlace (sin iniciar sesión), ve el detalle de lo que debe y puede
 * informar un pago con su comprobante. Solo expone la foto de SU liquidación; nunca datos de otras personas ni del propietario.
 */
@Injectable()
export class CobroPublicoService {
  private readonly limite = new LimiteTasa();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metodos: MetodosPagoService,
    private readonly objeciones: ObjecionesCobroService,
  ) {}

  async ver(token: string) {
    const enlace = await this.enlaceVigente(token);
    this.limitar(`ver:${token}`, 60, 60_000);
    await this.prisma.enlacesCobroPersona
      .update({ where: { id: enlace.id }, data: { vistas: { increment: 1 }, ultima_vista_at: new Date() } })
      .catch(() => undefined); // contar visitas nunca debe romper la página

    const reportes = await this.prisma.reportesPagoPersona.findMany({
      where: { enlace_id: enlace.id },
      select: { id: true, monto_reportado: true, saldo_al_reportar: true, fecha_pago: true, estado: true, motivo_rechazo: true, monto_aprobado: true, created_at: true, comprobante_tamano: true },
      orderBy: { id: 'desc' },
      take: 10,
    });
    const snapshot = asegurarClaves(enlace.snapshot as unknown as SnapshotCobro);
    const [metodosPago, objeciones] = await Promise.all([this.metodos.publicos(enlace.owner_user_id), this.objeciones.deLaPersona(enlace.id)]);
    return {
      ...snapshot,
      metodosPago,
      objeciones,
      mensaje: enlace.mensaje,
      instruccionesPago: enlace.instrucciones_pago,
      venceEn: enlace.expira_at,
      actualizadoEn: enlace.snapshot_at,
      reportes: reportes.map((r) => ({
        id: r.id,
        monto: toDecimal(r.monto_reportado),
        fechaPago: r.fecha_pago,
        estado: r.estado,
        motivoRechazo: r.estado === 'RECHAZADO' ? r.motivo_rechazo : null,
        montoAprobado: r.monto_aprobado === null ? null : toDecimal(r.monto_aprobado),
        /** Avisó menos de lo que debía en ese momento: el resto sigue pendiente. */
        parcial: r.saldo_al_reportar !== null && toDecimal(r.monto_reportado).lessThan(toDecimal(r.saldo_al_reportar)),
        creadoEn: r.created_at,
        conComprobante: r.comprobante_tamano !== null,
      })),
    };
  }

  async reportar(token: string, dto: ReportarPagoDto) {
    const enlace = await this.enlaceVigente(token);
    this.limitar(`reportar:${token}`, 12, 10 * 60_000);

    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0) || monto.greaterThan(MAX_MONTO)) throw datosInvalidos({ monto: ['El monto no es válido'] });
    const fecha = parseIsoDate(dto.fechaPago);
    if (!fecha) throw datosInvalidos({ fechaPago: ['fechaPago debe tener formato yyyy-MM-dd'] });
    const hoy = Date.now();
    if (fecha.getTime() > hoy + 2 * 86_400_000) throw datosInvalidos({ fechaPago: ['La fecha del pago no puede ser futura'] });
    if (fecha.getTime() < hoy - VENTANA_FECHA_PAGO_DIAS * 86_400_000) throw datosInvalidos({ fechaPago: ['La fecha del pago es demasiado antigua'] });

    const pendientes = await this.prisma.reportesPagoPersona.count({ where: { enlace_id: enlace.id, estado: 'PENDIENTE' } });
    if (pendientes >= MAX_PENDIENTES_POR_ENLACE) {
      throw new HttpException({ message: 'Ya tienes varios pagos esperando revisión. Espera a que se confirmen antes de enviar otro.' }, HttpStatus.CONFLICT);
    }

    const comprobante = dto.comprobante ? validarComprobante(dto.comprobante) : null;
    // lo que debía al avisar: sirve para saber si es un abono parcial
    const saldo = money(new Decimal((enlace.snapshot as unknown as SnapshotCobro)?.resumen?.saldoTotalAcumulado ?? 0));
    const r = await this.prisma.reportesPagoPersona.create({
      data: {
        owner_user_id: enlace.owner_user_id,
        enlace_id: enlace.id,
        persona_id: enlace.persona_id,
        periodo: enlace.periodo,
        monto_reportado: toDbMoney(monto),
        saldo_al_reportar: saldo.greaterThan(0) ? toDbMoney(saldo) : null,
        fecha_pago: fecha,
        medio: dto.medio ?? null,
        referencia: dto.referencia?.trim() || null,
        comentario: dto.comentario?.trim() || null,
        comprobante_nombre: comprobante?.nombre ?? null,
        comprobante_tipo: comprobante?.tipo ?? null,
        comprobante_tamano: comprobante?.tamano ?? null,
        comprobante: comprobante ? new Uint8Array(comprobante.datos) : null,
      },
      select: { id: true, estado: true, created_at: true },
    });
    const parcial = saldo.greaterThan(0) && monto.lessThan(saldo);
    return {
      id: r.id,
      estado: r.estado,
      creadoEn: r.created_at,
      parcial,
      saldoRestante: parcial ? money(saldo.minus(monto)) : null,
      mensaje: parcial
        ? 'Recibimos tu abono. Quien te cobra lo revisará y lo confirmará; el resto sigue pendiente.'
        : 'Recibimos tu reporte. Quien te cobra lo revisará y lo confirmará.',
    };
  }

  /** La persona observa un cobro (o el total): comentario obligatorio; queda pendiente de la respuesta del propietario. */
  async objetar(token: string, dto: ObjetarCobroDto) {
    const enlace = await this.enlaceVigente(token);
    this.limitar(`objetar:${token}`, 10, 10 * 60_000);
    return this.objeciones.crear(enlace, dto);
  }

  // ───────────────────────────── Portal del acreedor (Fase 6) ─────────────────────────────

  /**
   * Vista pública de un préstamo POR_PAGAR por su token: cuánto se debía, abonos con su cuenta
   * destino y comprobantes. Sin JWT; el token (único, aleatorio) es la credencial.
   */
  async verComprobantePrestamo(token: string) {
    const prestamo = await this.prestamoPorToken(token);
    this.limitar(`prestamo:${token}`, 60, 60_000);
    const abonos = await this.prisma.abonosPrestamoPasivo.findMany({ where: { prestamo_id: prestamo.id }, orderBy: { fecha_hora_pago: 'asc' } });
    const totalAbonado = abonos.reduce((acc, a) => acc.plus(toDecimal(a.monto)), new Decimal(0));
    const saldo = money(toDecimal(prestamo.saldo_pendiente ?? prestamo.valor_prestado));
    const ultimo = abonos[abonos.length - 1];
    return {
      tipo: 'PORTAL_ACREEDOR' as const,
      estadoPrestamo: saldo.greaterThan(0) ? 'ABONO_PARCIAL_REALIZADO' : 'PAGADO TOTALMENTE',
      concepto: prestamo.concepto,
      acreedor: prestamo.responsable_ref?.nombre ?? null,
      valorInicial: money(toDecimal(prestamo.valor_prestado)),
      totalAbonado: money(totalAbonado),
      saldoPendiente: saldo,
      fechaCompromisoPago: prestamo.fecha_compromiso_pago,
      cuentaDestinoTercero: prestamo.cuenta_destino_tercero,
      ultimoPago: ultimo
        ? {
            monto: money(toDecimal(ultimo.monto)),
            fechaHoraPago: ultimo.fecha_hora_pago,
            cuentaDestinoDetalle: ultimo.cuenta_destino_detalle,
            conComprobante: ultimo.comprobante_tamano !== null,
            comprobanteUrl: ultimo.comprobante_tamano !== null ? `/api/publico/comprobante-prestamo/${token}/abonos/${Number(ultimo.id)}/comprobante` : null,
          }
        : null,
      historialAbonos: abonos.map((a) => ({
        id: Number(a.id),
        monto: money(toDecimal(a.monto)),
        fechaHoraPago: a.fecha_hora_pago,
        cuentaDestinoDetalle: a.cuenta_destino_detalle,
        conComprobante: a.comprobante_tamano !== null,
        comprobanteUrl: a.comprobante_tamano !== null ? `/api/publico/comprobante-prestamo/${token}/abonos/${Number(a.id)}/comprobante` : null,
      })),
    };
  }

  async comprobantePrestamo(token: string, abonoId: number) {
    const prestamo = await this.prestamoPorToken(token);
    this.limitar(`prestamo-archivo:${token}`, 30, 60_000);
    const abono = await this.prisma.abonosPrestamoPasivo.findFirst({ where: { id: BigInt(abonoId), prestamo_id: prestamo.id } });
    if (!abono?.comprobante || !abono.comprobante_tipo) throw new NotFoundException(ENLACE_INVALIDO);
    return { datos: Buffer.from(abono.comprobante), tipo: abono.comprobante_tipo, nombre: abono.comprobante_nombre ?? 'comprobante' };
  }

  private async prestamoPorToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException(ENLACE_INVALIDO);
    const prestamo = await this.prisma.prestamos.findFirst({
      where: { token_consulta_publica: token, direccion_prestamo: 'POR_PAGAR' },
      include: { responsable_ref: { select: { nombre: true } } },
    });
    if (!prestamo) throw new NotFoundException(ENLACE_INVALIDO);
    return prestamo;
  }

  /** Imagen QR de un medio de pago activo del propietario del enlace. */
  async qrMetodo(token: string, metodoId: number) {
    const enlace = await this.enlaceVigente(token);
    this.limitar(`qr:${token}`, 60, 60_000);
    return this.metodos.qrPublico(metodoId, enlace.owner_user_id);
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async enlaceVigente(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException(ENLACE_INVALIDO);
    const enlace = await this.prisma.enlacesCobroPersona.findUnique({ where: { token } });
    if (!enlace || enlace.revocado || enlace.expira_at.getTime() <= Date.now()) throw new NotFoundException(ENLACE_INVALIDO);
    return enlace;
  }

  private limitar(clave: string, max: number, ventanaMs: number): void {
    if (!this.limite.permitir(clave, max, ventanaMs)) {
      throw new HttpException({ message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

