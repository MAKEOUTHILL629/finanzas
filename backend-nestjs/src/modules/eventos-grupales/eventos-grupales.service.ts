import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money, toDbMoney, toDecimal } from '../../common/utils/decimal.util';
import { datosInvalidos } from '../../common/utils/legacy-http.util';
import { idNum } from '../../common/utils/legacy-format.util';
import { PrismaService } from '../../prisma/prisma.service';
import { GastoEvento, liquidarEvento, ParticipanteEvento } from './eventos-grupales.calc';

@Injectable()
export class EventosGrupalesService {
  constructor(private readonly prisma: PrismaService) {}

  listar(ownerUserId: bigint) {
    return this.prisma.eventosLiquidacionGrupal.findMany({
      where: { owner_user_id: ownerUserId },
      include: { participantes: { include: { persona: { select: { nombre: true } } } }, _count: { select: { gastos: true } } },
      orderBy: { id: 'desc' },
    });
  }

  async crear(ownerUserId: bigint, dto: { nombre: string; fechaInicio?: string; fechaFin?: string; participantes: Array<{ personaId: number; aliasBloque?: string; peso?: number | string }> }) {
    if (!dto.nombre?.trim()) throw datosInvalidos({ nombre: ['nombre es obligatorio'] });
    if (!dto.participantes?.length) throw datosInvalidos({ participantes: ['Indica al menos un participante'] });
    const evento = await this.prisma.eventosLiquidacionGrupal.create({
      data: {
        owner_user_id: ownerUserId,
        nombre: dto.nombre.trim(),
        fecha_inicio: dto.fechaInicio ? new Date(`${dto.fechaInicio}T00:00:00Z`) : null,
        fecha_fin: dto.fechaFin ? new Date(`${dto.fechaFin}T00:00:00Z`) : null,
        participantes: {
          create: dto.participantes.map((p) => ({
            persona_id: BigInt(p.personaId),
            alias_bloque: p.aliasBloque ?? null,
            peso_participacion: toDbMoney(toDecimal(p.peso ?? 1)),
          })),
        },
      },
      include: { participantes: true },
    });
    return evento;
  }

  async agregarGasto(ownerUserId: bigint, eventoId: number, dto: { descripcion: string; montoTotal: number | string; pagadoPorParticipanteId: number; tipoDivision?: GastoEvento['tipoDivision']; divisionJson?: Record<string, number | string>; fecha?: string }) {
    const evento = await this.requireEvento(ownerUserId, eventoId);
    if (evento.estado === 'CERRADO') throw datosInvalidos({ estado: ['El evento está cerrado'] });
    const monto = money(toDecimal(dto.montoTotal));
    if (!monto.greaterThan(0)) throw datosInvalidos({ montoTotal: ['montoTotal debe ser mayor a 0'] });
    const pagador = await this.prisma.participantesEventoGrupal.findFirst({ where: { id: BigInt(dto.pagadoPorParticipanteId), evento_id: evento.id } });
    if (!pagador) throw new NotFoundException(`Participante ${dto.pagadoPorParticipanteId} no encontrado en el evento`);
    return this.prisma.gastosEventoGrupal.create({
      data: {
        evento_id: evento.id,
        descripcion: dto.descripcion.slice(0, 255),
        monto_total: toDbMoney(monto),
        pagado_por_participante_id: pagador.id,
        tipo_division: dto.tipoDivision ?? 'PARTES_IGUALES',
        division_json: (dto.divisionJson ?? undefined) as Prisma.InputJsonObject | undefined,
        fecha: dto.fecha ? new Date(`${dto.fecha}T00:00:00Z`) : null,
      },
    });
  }

  async liquidar(ownerUserId: bigint, eventoId: number) {
    const evento = await this.requireEvento(ownerUserId, eventoId);
    const [participantesDb, gastosDb] = await Promise.all([
      this.prisma.participantesEventoGrupal.findMany({ where: { evento_id: evento.id }, include: { persona: { select: { nombre: true } } } }),
      this.prisma.gastosEventoGrupal.findMany({ where: { evento_id: evento.id }, orderBy: { id: 'asc' } }),
    ]);
    const participantes: ParticipanteEvento[] = participantesDb.map((p) => ({
      participanteId: idNum(p.id),
      personaId: idNum(p.persona_id),
      alias: p.alias_bloque ?? p.persona?.nombre ?? null,
      peso: toDecimal(p.peso_participacion),
    }));
    const gastos: GastoEvento[] = gastosDb.map((g) => ({
      descripcion: g.descripcion,
      montoTotal: toDecimal(g.monto_total),
      pagadoPorParticipanteId: idNum(g.pagado_por_participante_id),
      tipoDivision: (g.tipo_division as GastoEvento['tipoDivision']) ?? 'PARTES_IGUALES',
      divisionJson: (g.division_json as Record<string, number | string> | null) ?? null,
    }));
    const resultado = liquidarEvento(participantes, gastos);
    return {
      evento: { id: idNum(evento.id), nombre: evento.nombre, estado: evento.estado },
      gastos: gastosDb.map((g) => ({ id: idNum(g.id), descripcion: g.descripcion, montoTotal: money(toDecimal(g.monto_total)), pagadoPorParticipanteId: idNum(g.pagado_por_participante_id), tipoDivision: g.tipo_division })),
      ...resultado,
    };
  }

  async cerrar(ownerUserId: bigint, eventoId: number) {
    const evento = await this.requireEvento(ownerUserId, eventoId);
    await this.prisma.eventosLiquidacionGrupal.update({ where: { id: evento.id }, data: { estado: 'CERRADO' } });
    return this.liquidar(ownerUserId, eventoId);
  }

  private async requireEvento(ownerUserId: bigint, eventoId: number) {
    const e = await this.prisma.eventosLiquidacionGrupal.findFirst({ where: { id: BigInt(eventoId), owner_user_id: ownerUserId } });
    if (!e) throw new NotFoundException(`Evento ${eventoId} no encontrado`);
    return e;
  }
}
