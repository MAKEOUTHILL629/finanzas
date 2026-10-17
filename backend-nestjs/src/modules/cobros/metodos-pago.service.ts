import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { assertCuenta } from '../../common/utils/ownership.util';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_QR_BYTES, TIPOS_QR, TipoMetodoPago, errorDeNumeroMetodo } from './ajustes-cobro.util';
import { validarComprobante } from './comprobante.util';
import { ActualizarMetodoPagoDto, CrearMetodoPagoDto, QrMetodoPagoDto } from './dto/cobros-fase6.dto';

/** Columnas sin los bytes del QR (solo se piden aparte). */
const SIN_QR = {
  id: true,
  tipo: true,
  entidad: true,
  numero: true,
  titular: true,
  documento: true,
  instrucciones: true,
  cuenta_id: true,
  qr_tamano: true,
  activo: true,
  orden: true,
  created_at: true,
} satisfies Prisma.MetodosPagoUsuarioSelect;

type Metodo = Prisma.MetodosPagoUsuarioGetPayload<{ select: typeof SIN_QR }>;

/** Lo que ve la persona en su enlace: sin cuenta interna, sin orden, sin banderas del propietario. */
export interface MetodoPagoPublico {
  id: bigint;
  tipo: string;
  entidad: string;
  numero: string;
  titular: string | null;
  documento: string | null;
  instrucciones: string | null;
  tieneQr: boolean;
}

/**
 * Medios de pago del propietario (dónde le pueden transferir): se gestionan en la app y el enlace público de cobro muestra los
 * activos con un botón «Copiar» por cada uno. El QR (opcional) es una imagen pequeña guardada con el medio.
 */
@Injectable()
export class MetodosPagoService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(ownerUserId: bigint) {
    const filas = await this.prisma.metodosPagoUsuario.findMany({ where: { owner_user_id: ownerUserId }, select: SIN_QR, orderBy: [{ orden: 'asc' }, { id: 'asc' }] });
    return filas.map((m) => this.vista(m));
  }

  async crear(dto: CrearMetodoPagoDto, ownerUserId: bigint) {
    this.validarNumero(dto.tipo, dto.numero);
    if (dto.cuentaId !== undefined) await assertCuenta(this.prisma, dto.cuentaId, ownerUserId);
    const orden = dto.orden ?? (await this.siguienteOrden(ownerUserId));
    const m = await this.prisma.metodosPagoUsuario.create({
      data: {
        owner_user_id: ownerUserId,
        tipo: dto.tipo,
        entidad: dto.entidad.trim(),
        numero: dto.numero.trim(),
        titular: dto.titular?.trim() || null,
        documento: dto.documento?.trim() || null,
        instrucciones: dto.instrucciones?.trim() || null,
        cuenta_id: dto.cuentaId === undefined ? null : BigInt(dto.cuentaId),
        activo: dto.activo ?? true,
        orden,
      },
      select: SIN_QR,
    });
    return this.vista(m);
  }

  async actualizar(id: number, dto: ActualizarMetodoPagoDto, ownerUserId: bigint) {
    const actual = await this.requerir(id, ownerUserId);
    const tipo = (dto.tipo ?? actual.tipo) as TipoMetodoPago;
    const numero = dto.numero ?? actual.numero;
    if (dto.tipo !== undefined || dto.numero !== undefined) this.validarNumero(tipo, numero);
    if (dto.cuentaId !== undefined && dto.cuentaId !== null) await assertCuenta(this.prisma, dto.cuentaId, ownerUserId);
    const limpio = (v: string | null | undefined): string | null | undefined => (v === undefined ? undefined : v === null ? null : v.trim() || null);
    const m = await this.prisma.metodosPagoUsuario.update({
      where: { id: actual.id },
      data: {
        ...(dto.tipo !== undefined ? { tipo: dto.tipo } : {}),
        ...(dto.entidad !== undefined ? { entidad: dto.entidad.trim() } : {}),
        ...(dto.numero !== undefined ? { numero: dto.numero.trim() } : {}),
        ...(dto.titular !== undefined ? { titular: limpio(dto.titular) } : {}),
        ...(dto.documento !== undefined ? { documento: limpio(dto.documento) } : {}),
        ...(dto.instrucciones !== undefined ? { instrucciones: limpio(dto.instrucciones) } : {}),
        ...(dto.cuentaId !== undefined ? { cuenta_id: dto.cuentaId === null ? null : BigInt(dto.cuentaId) } : {}),
        ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
        ...(dto.orden !== undefined ? { orden: dto.orden } : {}),
        updated_at: new Date(),
      },
      select: SIN_QR,
    });
    return this.vista(m);
  }

  async eliminar(id: number, ownerUserId: bigint): Promise<{ eliminado: true }> {
    const m = await this.requerir(id, ownerUserId);
    await this.prisma.metodosPagoUsuario.delete({ where: { id: m.id } });
    return { eliminado: true };
  }

  async guardarQr(id: number, dto: QrMetodoPagoDto, ownerUserId: bigint) {
    const m = await this.requerir(id, ownerUserId);
    if (!(TIPOS_QR as readonly string[]).includes(dto.qr.tipo)) throw datosInvalidos({ qr: ['El QR debe ser una imagen JPG, PNG o WebP'] });
    const archivo = validarComprobante(dto.qr);
    if (archivo.tamano > MAX_QR_BYTES) throw datosInvalidos({ qr: [`El QR pesa ${(archivo.tamano / 1000).toFixed(0)} KB y el máximo es ${MAX_QR_BYTES / 1000} KB`] });
    const r = await this.prisma.metodosPagoUsuario.update({
      where: { id: m.id },
      data: { qr: new Uint8Array(archivo.datos), qr_tipo: archivo.tipo, qr_tamano: archivo.tamano, updated_at: new Date() },
      select: SIN_QR,
    });
    return this.vista(r);
  }

  async quitarQr(id: number, ownerUserId: bigint) {
    const m = await this.requerir(id, ownerUserId);
    const r = await this.prisma.metodosPagoUsuario.update({ where: { id: m.id }, data: { qr: null, qr_tipo: null, qr_tamano: null, updated_at: new Date() }, select: SIN_QR });
    return this.vista(r);
  }

  /** Imagen del QR (para la vista previa del propietario). */
  async qr(id: number, ownerUserId: bigint) {
    return this.leerQr({ id: BigInt(id), owner_user_id: ownerUserId });
  }

  // ───────────────────────────── lado público ─────────────────────────────

  /** Los medios activos que se muestran en el enlace de cobro (en el orden elegido). */
  async publicos(ownerUserId: bigint): Promise<MetodoPagoPublico[]> {
    const filas = await this.prisma.metodosPagoUsuario.findMany({ where: { owner_user_id: ownerUserId, activo: true }, select: SIN_QR, orderBy: [{ orden: 'asc' }, { id: 'asc' }] });
    return filas.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      entidad: m.entidad,
      numero: m.numero,
      titular: m.titular,
      documento: m.documento,
      instrucciones: m.instrucciones,
      tieneQr: m.qr_tamano !== null,
    }));
  }

  /** QR de un medio ACTIVO del propietario del enlace. */
  async qrPublico(id: number, ownerUserId: bigint) {
    return this.leerQr({ id: BigInt(id), owner_user_id: ownerUserId, activo: true });
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async leerQr(where: Prisma.MetodosPagoUsuarioWhereInput) {
    const m = await this.prisma.metodosPagoUsuario.findFirst({ where, select: { qr: true, qr_tipo: true } });
    if (!m || !m.qr) throw new NotFoundException('Este medio de pago no tiene QR');
    return { datos: Buffer.from(m.qr), tipo: m.qr_tipo ?? 'image/png' };
  }

  private validarNumero(tipo: TipoMetodoPago, numero: string): void {
    const error = errorDeNumeroMetodo(tipo, numero);
    if (error) throw datosInvalidos({ numero: [error] });
  }

  private async requerir(id: number, ownerUserId: bigint) {
    const m = await this.prisma.metodosPagoUsuario.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, select: SIN_QR });
    if (!m) throw new NotFoundException(`Medio de pago ${id} no encontrado`);
    return m;
  }

  private async siguienteOrden(ownerUserId: bigint): Promise<number> {
    const r = await this.prisma.metodosPagoUsuario.aggregate({ where: { owner_user_id: ownerUserId }, _max: { orden: true } });
    return (r._max.orden ?? -1) + 1;
  }

  private vista(m: Metodo) {
    return {
      id: m.id,
      tipo: m.tipo,
      entidad: m.entidad,
      numero: m.numero,
      titular: m.titular,
      documento: m.documento,
      instrucciones: m.instrucciones,
      cuentaId: m.cuenta_id,
      tieneQr: m.qr_tamano !== null,
      activo: m.activo,
      orden: m.orden,
      creadoEn: m.created_at,
    };
  }
}
