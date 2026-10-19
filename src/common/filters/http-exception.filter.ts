/**
 * Global exception filter. Catches every error thrown during a request and
 * converts it into a consistent JSON body (see ErrorResponseDto).
 */

// Nest building blocks for writing an exception filter.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
// Express request/response types (type-only import).
import type { Request, Response } from 'express';
// The response shape we send back.
import { ErrorResponseDto } from '../dto/error-response.dto.js';

// @Catch() with no arguments means "catch every kind of exception".
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // Logger used to record unexpected (non-HTTP) errors.
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** Called by Nest whenever an exception escapes a route handler. */
  catch(exception: unknown, host: ArgumentsHost) {
    // Switch to the HTTP context to access request and response.
    const ctx = host.switchToHttp();
    // Express response object, used to send the error.
    const response = ctx.getResponse<Response>();
    // Express request object, used to include the path in the error.
    const request = ctx.getRequest<Request>();

    // Use the exception's status for HTTP errors, otherwise 500.
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Defaults for unknown errors (don't leak internal details to clients).
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    // Known HTTP exceptions carry a safe, client-facing body.
    if (exception instanceof HttpException) {
      // The body can be a plain string or an object.
      const body = exception.getResponse();
      if (typeof body === 'string') {
        // String body: use it directly as the message.
        message = body;
        error = exception.name;
      } else {
        // Object body (e.g. from ValidationPipe): pull out message and error.
        const { message: m, error: e } = body as Record<string, any>;
        // Fall back to the exception's own values if fields are missing.
        message = m ?? exception.message;
        error = e ?? exception.name;
      }
    } else {
      // Unexpected error: log it with stack trace for debugging.
      this.logger.error(exception);
    }

    // Build the standard error body.
    const payload: ErrorResponseDto = {
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };
    // Send it with the matching HTTP status code.
    response.status(status).json(payload);
  }
}
