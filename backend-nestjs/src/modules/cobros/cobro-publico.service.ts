import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { parseIsoDate } from '../../common/utils/date.util';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { LimiteTasa } from '../../common/utils/rate-limit.util';
import { PrismaService } from '../../prisma/prisma.service';
import { validarComprobante } from './comprobante.util';
import { ReportarPagoDto } from './dto/cobros.dto';
import { SnapshotCobro } from './enlaces-cobro.service';

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

  constructor(private readonly prisma: PrismaService) {}

  async ver(token: string) {
    const enlace = await this.enlaceVigente(token);
    this.limitar(`ver:${token}`, 60, 60_000);
    await this.prisma.enlacesCobroPersona
      .update({ where: { id: enlace.id }, data: { vistas: { increment: 1 }, ultima_vista_at: new Date() } })
      .catch(() => undefined); // contar visitas nunca debe romper la página

    const reportes = await this.prisma.reportesPagoPersona.findMany({
      where: { enlace_id: enlace.id },
      select: { id: true, monto_reportado: true, fecha_pago: true, estado: true, motivo_rechazo: true, monto_aprobado: true, created_at: true, comprobante_tamano: true },
      orderBy: { id: 'desc' },
      take: 10,
    });
    const snapshot = enlace.snapshot as unknown as SnapshotCobro;
    return {
      ...snapshot,
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
    const r = await this.prisma.reportesPagoPersona.create({
      data: {
        owner_user_id: enlace.owner_user_id,
        enlace_id: enlace.id,
        persona_id: enlace.persona_id,
        periodo: enlace.periodo,
        monto_reportado: toDbMoney(monto),
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
    return { id: r.id, estado: r.estado, creadoEn: r.created_at, mensaje: 'Recibimos tu reporte. Quien te cobra lo revisará y lo confirmará.' };
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

