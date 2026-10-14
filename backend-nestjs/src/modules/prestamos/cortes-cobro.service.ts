import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseIsoDate, todayLocal } from '../../common/utils/date.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCorteCobroDto, UpdateCorteCobroDto } from './dto/prestamo.dto';
import { PrestamosService } from './prestamos.service';

@Injectable()
export class CortesCobroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prestamos: PrestamosService,
  ) {}

  list(ownerUserId: bigint, estado?: string) {
    return this.prisma.cortesCobro.findMany({
      where: { owner_user_id: ownerUserId, ...(estado ? { estado } : {}) },
      orderBy: { fecha_inicio: 'desc' },
    });
  }

  /** Corte vigente según la fecha de hoy (o el marcado ACTIVO si ninguno contiene hoy). */
  async activo(ownerUserId: bigint, hoy: Date = todayLocal()) {
    const id = await this.prestamos.corteParaFecha(this.prisma, ownerUserId, hoy);
    if (!id) throw new NotFoundException('No hay un corte de cobro activo');
    return this.prisma.cortesCobro.findUniqueOrThrow({ where: { id } });
  }

  async create(dto: CreateCorteCobroDto, ownerUserId: bigint) {
    const { inicio, fin } = this.fechas(dto.fechaInicio, dto.fechaFinal);
    return this.prisma.cortesCobro.create({
      data: {
        owner_user_id: ownerUserId,
        concepto: dto.concepto,
        fecha_inicio: inicio,
        fecha_final: fin,
        estado: dto.estado ?? 'FUTURO',
      },
    });
  }

  async update(id: number, dto: UpdateCorteCobroDto, ownerUserId: bigint) {
    const actual = await this.require(id, ownerUserId);
    const data: Prisma.CortesCobroUncheckedUpdateInput = {};
    if (dto.concepto !== undefined) data.concepto = dto.concepto;
    if (dto.estado !== undefined) data.estado = dto.estado;
    if (dto.fechaInicio !== undefined || dto.fechaFinal !== undefined) {
      const { inicio, fin } = this.fechas(
        dto.fechaInicio ?? actual.fecha_inicio.toISOString().slice(0, 10),
        dto.fechaFinal ?? actual.fecha_final.toISOString().slice(0, 10),
      );
      data.fecha_inicio = inicio;
      data.fecha_final = fin;
    }
    return this.prisma.cortesCobro.update({ where: { id: actual.id }, data });
  }

  async remove(id: number, ownerUserId: bigint): Promise<void> {
    const actual = await this.require(id, ownerUserId);
    const enUso = await this.prisma.prestamos.count({ where: { corte_id: actual.id } });
    if (enUso > 0) {
      throw new ConflictException(`El corte tiene ${enUso} préstamo(s) asociados y no se puede eliminar`);
    }
    await this.prisma.cortesCobro.delete({ where: { id: actual.id } });
  }

  private async require(id: number, ownerUserId: bigint) {
    const corte = await this.prisma.cortesCobro.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
    if (!corte) throw new NotFoundException(`Corte ${id} no encontrado`);
    return corte;
  }

  private fechas(inicioStr: string, finStr: string): { inicio: Date; fin: Date } {
    const inicio = parseIsoDate(inicioStr);
    const fin = parseIsoDate(finStr);
    if (!inicio || !fin) throw datosInvalidos({ fechas: ['Las fechas deben tener formato yyyy-MM-dd'] });
    if (fin.getTime() < inicio.getTime()) {
      throw datosInvalidos({ fechaFinal: ['fechaFinal no puede ser anterior a fechaInicio'] });
    }
    return { inicio, fin };
  }
}
