import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoPrestamo, EstadoTransaccion, OrigenRegistro, TipoTransaccion } from '../../common/enums/finance.enums';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { validarComprobante } from '../cobros/comprobante.util';
import { TransaccionesService } from '../transacciones/transacciones.service';
import { AbonoPrestamoPasivoDto } from './dto/prestamo.dto';

const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/** Resumen puro del préstamo pasivo tras un abono (testeable). */
export function resumenTrasAbono(valorPrestado: import('../../config/decimal.config').Decimal, totalAbonado: import('../../config/decimal.config').Decimal) {
  const saldo = money(valorPrestado.minus(totalAbonado));
  return {
    valorInicial: money(valorPrestado),
    totalAbonado: money(totalAbonado),
    saldoPendiente: saldo.greaterThan(0) ? saldo : money(toDecimal(0)),
    pagadoTotalmente: !saldo.greaterThan(0),
  };
}

@Injectable()
export class PrestamosPasivosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transacciones: TransaccionesService,
  ) {}

  /** Registra un pago tuyo al acreedor: comprobante, egreso en tu cuenta, descuento del saldo. */
  async registrarAbonoConComprobante(prestamoId: number, dto: AbonoPrestamoPasivoDto, ownerUserId: bigint) {
    const monto = money(toDecimal(dto.monto));
    if (!monto.greaterThan(0)) throw datosInvalidos({ monto: ['monto debe ser mayor a 0'] });
    const comprobante = dto.comprobante ? validarComprobante(dto.comprobante) : null;

    return this.prisma.$transaction(async (tx) => {
      const prestamo = await tx.prestamos.findFirst({ where: { id: BigInt(prestamoId), owner_user_id: ownerUserId }, include: { responsable_ref: { select: { nombre: true } } } });
      if (!prestamo) throw new NotFoundException(`Préstamo ${prestamoId} no encontrado`);
      if ((prestamo.direccion_prestamo ?? 'POR_COBRAR') !== 'POR_PAGAR') {
        throw datosInvalidos({ direccionPrestamo: ['Este endpoint es para préstamos POR_PAGAR (dinero que te prestaron a ti)'] });
      }
      const saldoActual = toDecimal(prestamo.saldo_pendiente ?? prestamo.valor_prestado);
      if (monto.greaterThan(saldoActual)) throw datosInvalidos({ monto: [`El abono ($${monto}) supera el saldo pendiente ($${saldoActual})`] });

      let transaccionId: bigint | null = null;
      if (dto.cuentaOrigenId !== undefined) {
        const t = await this.transacciones.insertar(
          tx,
          {
            tipoTransaccion: TipoTransaccion.EGRESO,
            cuentaOrigenId: dto.cuentaOrigenId,
            cuentaDestinoId: null,
            tarjetaPagadaId: null,
            categoriaId: null,
            fechaTransaccion: new Date(),
            concepto: `Pago préstamo ${prestamo.concepto ?? ''}`.slice(0, 255),
            monedaOriginal: 'COP',
            montoOriginal: monto.toString(),
            origenRegistro: OrigenRegistro.MANUAL,
            estado: EstadoTransaccion.CONFIRMADO,
            notas: `Abono a préstamo POR_PAGAR #${prestamoId} · Destino: ${dto.cuentaDestinoDetalle ?? prestamo.cuenta_destino_tercero ?? '—'}`,
          },
          ownerUserId,
        );
        transaccionId = t.id;
      }

      const abono = await tx.abonosPrestamoPasivo.create({
        data: {
          prestamo_id: prestamo.id,
          owner_user_id: ownerUserId,
          monto: toDbMoney(monto),
          cuenta_origen_id: dto.cuentaOrigenId !== undefined ? BigInt(dto.cuentaOrigenId) : null,
          cuenta_destino_detalle: dto.cuentaDestinoDetalle?.trim() || prestamo.cuenta_destino_tercero,
          comprobante: comprobante ? new Uint8Array(comprobante.datos) : null,
          comprobante_nombre: comprobante?.nombre ?? null,
          comprobante_tipo: comprobante?.tipo ?? null,
          comprobante_tamano: comprobante?.tamano ?? null,
          comprobante_url: comprobante ? `/api/publico/comprobante-prestamo/${prestamo.token_consulta_publica ?? ''}` : null,
          transaccion_id: transaccionId,
          observaciones: dto.observaciones ?? null,
        },
      });

      const abonadoPrevio = await tx.abonosPrestamoPasivo.aggregate({ where: { prestamo_id: prestamo.id }, _sum: { monto: true } });
      const totalAbonado = toDecimal(abonadoPrevio._sum.monto);
      const resumen = resumenTrasAbono(toDecimal(prestamo.valor_prestado), totalAbonado);
      await tx.prestamos.update({
        where: { id: prestamo.id },
        data: { saldo_pendiente: toDbMoney(resumen.saldoPendiente), ...(resumen.pagadoTotalmente ? { estado: EstadoPrestamo.PAGADO } : {}) },
      });

      return {
        abonoId: idNum(abono.id),
        prestamoId,
        montoPagado: monto,
        cuentaDestinoDetalle: abono.cuenta_destino_detalle,
        fechaHoraPago: abono.fecha_hora_pago,
        transaccionId: transaccionId ? idNum(transaccionId) : null,
        conComprobante: comprobante !== null,
        tokenConsultaPublica: prestamo.token_consulta_publica,
        acreedor: prestamo.responsable_ref?.nombre ?? null,
        ...resumen,
      };
    }, TX_OPTIONS);
  }

  async listarAbonos(prestamoId: number, ownerUserId: bigint) {
    const prestamo = await this.prisma.prestamos.findFirst({ where: { id: BigInt(prestamoId), owner_user_id: ownerUserId }, select: { id: true } });
    if (!prestamo) throw new NotFoundException(`Préstamo ${prestamoId} no encontrado`);
    const abonos = await this.prisma.abonosPrestamoPasivo.findMany({ where: { prestamo_id: prestamo.id }, orderBy: { fecha_hora_pago: 'desc' } });
    return abonos.map((a) => ({
      id: idNum(a.id),
      monto: money(toDecimal(a.monto)),
      fechaHoraPago: a.fecha_hora_pago,
      cuentaDestinoDetalle: a.cuenta_destino_detalle,
      cuentaOrigenId: a.cuenta_origen_id ? idNum(a.cuenta_origen_id) : null,
      comprobanteNombre: a.comprobante_nombre,
      conComprobante: a.comprobante_tamano !== null,
      transaccionId: a.transaccion_id ? idNum(a.transaccion_id) : null,
      observaciones: a.observaciones,
    }));
  }
}
