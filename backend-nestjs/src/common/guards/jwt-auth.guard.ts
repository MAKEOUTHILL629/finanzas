import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Cuerpos 401 idénticos a `JwtFilter.scala` (sin header / token inválido o expirado). */
export function unauthorizedFor(context: ExecutionContext, info?: { message?: string }): HttpException {
  const header = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers
    .authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return new HttpException({ status: 'error', message: 'Authorization header required' }, HttpStatus.UNAUTHORIZED);
  }
  return new HttpException(
    { status: 'error', message: 'Invalid or expired token', details: info?.message ?? 'invalid token' },
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Guard global. Equivale a `JwtFilter.scala` (filtro de todo `/api/*` salvo rutas excluidas) y a
 * `AuthenticatedAction.scala`. Los cuerpos 401 son idénticos a los de Play.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // Las peticiones OPTIONS (preflight CORS) pasan sin JWT.
    if (context.switchToHttp().getRequest<{ method: string }>().method === 'OPTIONS') return true;
    return super.canActivate(context);
  }

  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser | false,
    info: { message?: string } | undefined,
    context: ExecutionContext,
  ): TUser {
    if (err instanceof HttpException) throw err;
    if (user) return user;
    throw unauthorizedFor(context, info);
  }
}
