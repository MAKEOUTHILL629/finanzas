import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Users } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from './jwt.strategy';

export const JWT_ISSUER = 'Finanzas Makes';
const BCRYPT_ROUNDS = 10; // jbcrypt BCrypt.gensalt() usa 10 rondas por defecto

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  findByEmail(email: string): Promise<Users | null> {
    return this.prisma.users.findUnique({ where: { email } });
  }

  checkPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  }

  /** Mismo payload que Scala: { userId, email, role, name } + iss "Finanzas Makes", iat, exp (segundos). */
  signToken(user: Users): string {
    const expiresIn = Number(this.config.get<string | number>('JWT_EXPIRATION') ?? 3600);
    return this.jwt.sign(
      { userId: Number(user.id), email: user.email, role: user.role, name: user.name },
      { algorithm: 'HS256', issuer: JWT_ISSUER, expiresIn },
    );
  }

  /** Devuelve los claims si el token es válido (firma HS256 y no expirado); null en caso contrario. */
  verifyToken(token: string): JwtPayload | null {
    try {
      return this.jwt.verify<JwtPayload>(token, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }

  createUser(params: { email: string; passwordHash: string; name: string | null; role: string }): Promise<Users> {
    return this.prisma.users.create({
      data: {
        email: params.email,
        password_hash: params.passwordHash,
        role: params.role,
        name: params.name,
        is_active: true,
        provider: 'local',
      },
    });
  }
}
