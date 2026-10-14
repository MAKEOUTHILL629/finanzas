/* eslint-disable @typescript-eslint/no-explicit-any */
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp, setupSwagger } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaMock } from '../helpers/prisma-mock';

export const TEST_SECRET = process.env.JWT_SECRET as string;

export async function createTestApp(): Promise<{ app: NestExpressApplication; prisma: any }> {
  const prisma = createPrismaMock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  setupSwagger(app);
  await app.init();
  return { app, prisma };
}

/**
 * Token con EXACTAMENTE la forma que emite `AuthController.generateJwtToken` (Scala / jwt-scala):
 * HS256, claims userId/email/role/name + iss "Finanzas Makes" + iat/exp en segundos.
 */
export function scalaStyleToken(overrides: Record<string, unknown> = {}, opciones: { expiresInSeconds?: number; secret?: string } = {}) {
  const jwt = new JwtService({ secret: opciones.secret ?? TEST_SECRET });
  const ahora = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      userId: 7,
      email: 'felipe@example.com',
      role: 'user',
      name: 'Felipe',
      iss: 'Finanzas Makes',
      iat: ahora,
      exp: ahora + (opciones.expiresInSeconds ?? 3600),
      ...overrides,
    },
    { algorithm: 'HS256' },
  );
}

export const bearer = (token = scalaStyleToken()) => ({ Authorization: `Bearer ${token}` });
