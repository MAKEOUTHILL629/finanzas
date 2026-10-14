import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { idNum, timestampToDayMillis } from '../../common/utils/legacy-format.util';

@Injectable()
export class PersonasService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /api/personas` — JSON idéntico a `Json.writes[Persona]` (Regla 5: solo personas del usuario). */
  async listLegacy(ownerUserId: bigint) {
    const personas = await this.prisma.personas.findMany({
      where: { owner_user_id: ownerUserId },
      orderBy: { id: 'asc' },
    });
    return personas.map((p) => ({
      id: idNum(p.id),
      nombre: p.nombre,
      fechaCreacion: timestampToDayMillis(p.created_at),
      inicialesNombre: p.iniciales_nombre,
      colorRepresentativo: p.color_representativo,
      // esquema Supabase (superconjunto del contrato legacy)
      email: p.email,
      numeroCelular: p.numero_celular,
      linkedUserId: p.linked_user_id === null ? null : idNum(p.linked_user_id),
    }));
  }

  /** ¿Existe la persona y pertenece al usuario? */
  async assertOwned(personaId: bigint, ownerUserId: bigint): Promise<void> {
    const found = await this.prisma.personas.findFirst({
      where: { id: personaId, owner_user_id: ownerUserId },
      select: { id: true },
    });
    if (!found) throw new Error(`No se encontró la persona con ID ${personaId}`);
  }
}
