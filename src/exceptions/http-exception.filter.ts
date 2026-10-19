/**
 * Global exception filter. Converts every error into the standard body
 * `{ statusCode, type, message, data }` (the same shape as successful
 * responses), so clients only ever parse one format.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { I18nContext } from 'nestjs-i18n';
import { ERROR } from '../response/response.js';
import { translate } from '../response/translate.js';

/** Catches every exception (registered globally as APP_FILTER). */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  /**
   * Sends the error envelope. Non-HTTP contexts (queue workers) rethrow,
   * so BullMQ sees the original error.
   */
  catch(exception: unknown, host: ArgumentsHost) {
    // Only HTTP is handled here; queue workers have their own error handling.
    if (host.getType() !== 'http') throw exception;
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    const { status, type, data, args, detail } = this.describe(exception);
    const i18n = I18nContext.current();
    reply.status(status).send({
      statusCode: status,
      type,
      // Validation messages are already human-readable; show the first one.
      message: detail ?? translate(i18n, type, args),
      data: data ?? {},
    });
  }

  /**
   * Maps any exception to status, type and optional data/args/detail:
   * AppException keeps its type, ValidationPipe errors become
   * VALIDATION_ERROR, unknown errors become a logged 500.
   */
  private describe(exception: unknown): {
    status: number;
    type: string;
    data?: Record<string, unknown>;
    args?: Record<string, unknown>;
    detail?: string;
  } {
    if (exception instanceof ThrottlerException) {
      return { status: HttpStatus.TOO_MANY_REQUESTS, type: ERROR.TOO_MANY_REQUESTS.type };
    }
    if (!(exception instanceof HttpException)) {
      // Unexpected error: log it, never leak internals to the client.
      this.logger.error(exception);
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        type: ERROR.INTERNAL_SERVER_ERROR.type,
      };
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    if (typeof body === 'object' && body !== null && 'type' in body) {
      // AppException: { type, data, args }.
      const { type, data, args } = body as {
        type: string;
        data?: Record<string, unknown>;
        args?: Record<string, unknown>;
      };
      return { status, type, data, args };
    }

    // Built-in Nest exceptions (ValidationPipe, NotFound for unknown routes, ...).
    const message =
      typeof body === 'string'
        ? body
        : (body as { message?: string | string[] }).message;
    const messages = Array.isArray(message) ? message : [message ?? exception.message];
    if (status === HttpStatus.BAD_REQUEST && Array.isArray(message)) {
      return {
        status,
        type: ERROR.VALIDATION_ERROR.type,
        detail: messages[0],
        data: { errors: messages },
      };
    }
    if (status === HttpStatus.NOT_FOUND) {
      return { status, type: ERROR.NOT_FOUND.type, detail: messages[0] };
    }
    if (status >= 500) this.logger.error(exception);
    return {
      status,
      type: HttpStatus[status] ?? ERROR.BAD_REQUEST.type,
      detail: messages[0],
    };
  }
}
