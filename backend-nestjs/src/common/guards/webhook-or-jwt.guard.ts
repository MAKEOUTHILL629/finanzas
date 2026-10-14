import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { unauthorizedFor } from './jwt-auth.guard';

/** Comparación en tiempo constante (hash previo para igualar longitudes). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Autenticación dual para el webhook de sincronización por lotes:
 *  - `x-webhook-secret: <WEBHOOK_SECRET>` → actúa como el usuario `DEFAULT_OWNER_USER_ID` (Google Apps Script).
 *  - si no viene ese header → JWT normal (usuario autenticado desde Angular).
 * La ruta se marca `@Public()` para que el guard global no la bloquee; este guard hace la verificación real.
 */
@Injectable()
export class WebhookOrJwtGuard extends AuthGuard('jwt') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; user?: AuthenticatedUser }>();
    const provided = request.headers['x-webhook-secret'];

    if (provided !== undefined) {
      const secret = this.config.get<string>('WEBHOOK_SECRET');
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!secret || !value || !secretsMatch(value, secret)) {
        throw new HttpException({ status: 'error', message: 'Invalid webhook secret' }, HttpStatus.UNAUTHORIZED);
      }
      const owner = this.config.get<string | number>('DEFAULT_OWNER_USER_ID');
      if (owner === undefined || owner === null || owner === '') {
        throw new HttpException(
          { status: 'error', message: 'DEFAULT_OWNER_USER_ID no está configurado en el servidor' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      request.user = { userId: BigInt(owner), email: 'webhook', role: 'webhook', name: null };
      return true;
    }
    return (await super.canActivate(context)) as boolean;
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
