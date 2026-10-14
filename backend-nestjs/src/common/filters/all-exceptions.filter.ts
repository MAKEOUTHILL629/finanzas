import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { serializeForJson } from '../interceptors/json-serialization.interceptor';

/**
 * Manejo uniforme de errores HTTP y de Prisma.
 *  - HttpException con cuerpo propio (legacy: `{message}`, `{mensaje}`, `{status,message}`) → se respeta tal cual.
 *  - HttpException estándar de Nest (404 de ruta, validaciones v2) → `{statusCode,message,error}`.
 *  - Errores conocidos de Prisma → 4xx con mensaje legible.
 *  - Cualquier otro → 500 `{message}` (sin filtrar detalles internos).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toHttp(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    }
    response.status(status).json(serializeForJson(body));
  }

  private toHttp(exception: unknown): { status: number; body: unknown } {
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), body: exception.getResponse() };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            body: { message: `Registro duplicado (${this.target(exception)})` },
          };
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            body: { message: 'Violación de llave foránea: el registro está referenciado o la referencia no existe' },
          };
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, body: { message: 'Registro no encontrado' } };
        case 'P2000':
        case 'P2006':
        case 'P2007':
          return { status: HttpStatus.BAD_REQUEST, body: { message: 'Datos inválidos', details: exception.message } };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            body: { message: `Error de base de datos (${exception.code})` },
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, body: { message: 'Datos inválidos' } };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { message: 'Error interno del servidor' } };
  }

  private target(exception: Prisma.PrismaClientKnownRequestError): string {
    const target = exception.meta?.target;
    return Array.isArray(target) ? target.join(', ') : String(target ?? 'unique');
  }
}
