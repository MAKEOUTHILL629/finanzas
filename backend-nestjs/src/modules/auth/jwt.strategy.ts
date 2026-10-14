import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** Claims emitidos por `AuthController.generateJwtToken` (Scala): userId, email, role, name + iss/iat/exp. */
export interface JwtPayload {
  userId: number | string;
  email: string;
  role: string;
  name?: string | null;
  iss?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? config.getOrThrow<string>('APP_SECRET'),
      algorithms: ['HS256'],
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (payload.userId === undefined || payload.userId === null || !/^\d+$/.test(String(payload.userId))) {
      throw new UnauthorizedException({ status: 'error', message: 'Invalid or expired token' });
    }
    return {
      userId: BigInt(payload.userId),
      email: payload.email,
      role: payload.role,
      name: payload.name ?? null,
    };
  }
}
