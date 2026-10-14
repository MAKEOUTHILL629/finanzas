import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Usuario autenticado extraído del JWT (claims `userId`, `email`, `role`, `name`). */
export interface AuthenticatedUser {
  /** `Users.id` (int8) — se usa como `owner_user_id` en todas las consultas (Regla 5). */
  userId: bigint;
  email: string;
  role: string;
  name: string | null;
}

/**
 * `@CurrentUser()` → AuthenticatedUser completo.
 * `@CurrentUser('userId')` → solo el `Users.id` como bigint.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    return field ? user?.[field] : user;
  },
);
