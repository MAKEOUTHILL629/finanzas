/**
 * Efecto de lado: debe importarse PRIMERO en `main.ts` (antes de Nest/Prisma/ConfigModule) para que
 * `DATABASE_URL` exista cuando se valide el entorno y se construya el cliente Prisma.
 */
import { aplicarCompatibilidadScala } from './scala-env';

const aplicadas = aplicarCompatibilidadScala();
if (aplicadas.length > 0) {
  // Sin valores: solo qué se derivó y desde dónde (la URL lleva credenciales).
  console.log(`[env] ${aplicadas.join(', ')} derivadas de DB_URL/DB_USER/DB_PASSWORD (configuración compatible con Scala)`);
}
