import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Query, Headers } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';

/** Equivalente a la forma de `JsError.toJson` de Play: { "obj.campo": [{ msg: [...], args: [] }] }. */
function jsErrorDetails(problems: Array<[string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, msg] of problems) out[`obj.${field}`] = [{ msg: [msg], args: [] }];
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Iniciar sesión (devuelve JWT HS256)' })
  async login(@Body() body: unknown) {
    const problems: Array<[string, string]> = [];
    const data = isObject(body) ? body : {};
    for (const field of ['email', 'password']) {
      if (!(field in data)) problems.push([field, 'error.path.missing']);
      else if (typeof data[field] !== 'string') problems.push([field, 'error.expected.jsstring']);
    }
    if (problems.length > 0) {
      throw new HttpException(
        { status: 'error', message: 'Invalid JSON format', details: jsErrorDetails(problems) },
        HttpStatus.BAD_REQUEST,
      );
    }
    const email = data.email as string;
    const password = data.password as string;

    try {
      const user = await this.auth.findByEmail(email);
      if (!user) {
        throw new HttpException({ status: 'error', message: 'Invalid email or password' }, HttpStatus.UNAUTHORIZED);
      }
      if (!user.password_hash) {
        throw new HttpException(
          { status: 'error', message: 'Password login not available for this account. Try social login.' },
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (!(await this.auth.checkPassword(password, user.password_hash))) {
        throw new HttpException({ status: 'error', message: 'Invalid email or password' }, HttpStatus.UNAUTHORIZED);
      }
      return { status: 'ok', token: this.auth.signToken(user) };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { status: 'error', message: 'Internal server error', details: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar nuevo usuario' })
  async register(@Body() body: unknown) {
    const problems: Array<[string, string]> = [];
    const data = isObject(body) ? body : {};
    for (const field of ['email', 'password']) {
      if (!(field in data)) problems.push([field, 'error.path.missing']);
      else if (typeof data[field] !== 'string') problems.push([field, 'error.expected.jsstring']);
    }
    if ('name' in data && data.name !== null && typeof data.name !== 'string') {
      problems.push(['name', 'error.expected.jsstring']);
    }
    if (problems.length > 0) {
      throw new HttpException(
        { status: 'error', message: 'Invalid registration data', details: jsErrorDetails(problems) },
        HttpStatus.BAD_REQUEST,
      );
    }
    const email = data.email as string;
    const password = data.password as string;
    const name = typeof data.name === 'string' ? data.name : null;

    if (password.length < 8) {
      throw new HttpException(
        { status: 'error', message: 'Password must be at least 8 characters long' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const conflict = () =>
      new HttpException({ status: 'error', message: 'Email already registered' }, HttpStatus.CONFLICT);

    try {
      if (await this.auth.findByEmail(email)) throw conflict();
      const created = await this.auth.createUser({
        email,
        passwordHash: await this.auth.hashPassword(password),
        name,
        role: 'user',
      });
      return {
        status: 'ok',
        message: 'User registered successfully',
        user: {
          id: Number(created.id),
          email: created.email,
          role: created.role,
          name: created.name,
          avatarUrl: created.avatar_url,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict();
      throw new HttpException(
        { status: 'error', message: 'Failed to create user', details: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Placeholder idéntico al legacy: el flujo OAuth no está implementado (501). */
  @Public()
  @Get('callback/:provider')
  @ApiOperation({ summary: 'Callback OAuth (no implementado, 501)' })
  oauthCallback(@Param('provider') provider: string, @Query() query: Record<string, string | string[]>) {
    const received: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(query)) received[key] = Array.isArray(value) ? value : [value];
    throw new HttpException(
      {
        status: 'pending',
        message: `OAuth callback for provider '${provider}' not yet implemented.`,
        received_params: received,
      },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cerrar sesión (204, requiere JWT válido)' })
  logout(): void {
    // El JWT es stateless: no hay lista negra (igual que el legacy).
  }

  @Public()
  @Get('token-is-valid')
  @ApiOperation({ summary: 'Validar token JWT' })
  async tokenIsValid(@Headers('authorization') authorization?: string) {
    if (!authorization) {
      throw new HttpException({ status: 'error', message: 'Missing Authorization header' }, HttpStatus.UNAUTHORIZED);
    }
    if (!authorization.startsWith('Bearer ')) {
      throw new HttpException(
        { status: 'error', message: 'Invalid Authorization header format. Expected: Bearer <token>' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const claims = this.auth.verifyToken(authorization.substring(7));
    if (!claims) {
      throw new HttpException({ status: 'error', message: 'Invalid token' }, HttpStatus.UNAUTHORIZED);
    }
    try {
      const user = await this.auth.findByEmail(claims.email);
      if (!user) throw new HttpException({ status: 'error', message: 'User not found' }, HttpStatus.UNAUTHORIZED);
      return { status: 'ok' };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { status: 'error', message: 'Internal server error', details: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
