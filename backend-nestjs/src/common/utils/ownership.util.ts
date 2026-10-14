import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Regla 5 (multi-tenant): antes de referenciar una entidad por id, verificar que pertenece al usuario.
 * Todos lanzan 404 (no se revela si el id existe para otro usuario).
 */

export async function assertPersona(tx: Tx, id: bigint | number, ownerUserId: bigint): Promise<bigint> {
  const found = await tx.personas.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, select: { id: true } });
  if (!found) throw new NotFoundException(`Persona ${id} no encontrada`);
  return found.id;
}

export async function assertCuenta(tx: Tx, id: bigint | number, ownerUserId: bigint) {
  const found = await tx.cuentasFinancieras.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
  if (!found) throw new NotFoundException(`Cuenta financiera ${id} no encontrada`);
  return found;
}

export async function assertTarjeta(tx: Tx, id: bigint | number, ownerUserId: bigint): Promise<bigint> {
  const found = await tx.tarjetas.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, select: { id: true } });
  if (!found) throw new NotFoundException(`Tarjeta ${id} no encontrada`);
  return found.id;
}

/** Categorías del sistema (`owner_user_id IS NULL`) o propias. */
export async function assertCategoria(tx: Tx, id: bigint | number, ownerUserId: bigint): Promise<bigint> {
  const found = await tx.categorias.findFirst({
    where: { id: BigInt(id), OR: [{ owner_user_id: null }, { owner_user_id: ownerUserId }] },
    select: { id: true },
  });
  if (!found) throw new NotFoundException(`Categoría ${id} no encontrada`);
  return found.id;
}

export async function assertPrestamo(tx: Tx, id: bigint | number, ownerUserId: bigint): Promise<bigint> {
  const found = await tx.prestamos.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId }, select: { id: true } });
  if (!found) throw new NotFoundException(`Préstamo ${id} no encontrado`);
  return found.id;
}

export async function assertPeriodoRecurrente(tx: Tx, id: bigint | number, ownerUserId: bigint) {
  const found = await tx.periodosRecurrentes.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
  if (!found) throw new NotFoundException(`Periodo recurrente ${id} no encontrado`);
  return found;
}

export async function assertObligacion(tx: Tx, id: bigint | number, ownerUserId: bigint) {
  const found = await tx.obligacionesMes.findFirst({ where: { id: BigInt(id), owner_user_id: ownerUserId } });
  if (!found) throw new NotFoundException(`Obligación mensual ${id} no encontrada`);
  return found;
}
