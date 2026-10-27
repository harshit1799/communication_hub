/**
 * Global exception filter for the gRPC API. Every error becomes a gRPC
 * status:
 *
 *   code      standard gRPC code, mapped from the error's HTTP-style status
 *   details   human-readable message in the caller's `language`
 *   trailers  error-type: <ERROR type>, error-data: <JSON context> (if any)
 *
 * Unexpected errors are logged and returned as INTERNAL without internals.
 */

import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, RpcExceptionFilter } from '@nestjs/common';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { I18nService } from 'nestjs-i18n';
import { Observable, throwError } from 'rxjs';
import { METADATA } from '../constant/index.js';
import { ERROR } from '../response/response.js';
import { translate } from '../response/translate.js';
import { MetricsService } from '../utils/metrics/metrics.service.js';
import { recordRpc } from './rpc-context.js';

/** HTTP-style status -> gRPC code. */
const CODE_BY_STATUS: Record<number, GrpcStatus> = {
  [HttpStatus.BAD_REQUEST]: GrpcStatus.INVALID_ARGUMENT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: GrpcStatus.INVALID_ARGUMENT,
  [HttpStatus.UNAUTHORIZED]: GrpcStatus.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: GrpcStatus.PERMISSION_DENIED,
  [HttpStatus.NOT_FOUND]: GrpcStatus.NOT_FOUND,
  [HttpStatus.CONFLICT]: GrpcStatus.FAILED_PRECONDITION,
  [HttpStatus.TOO_MANY_REQUESTS]: GrpcStatus.RESOURCE_EXHAUSTED,
  [HttpStatus.SERVICE_UNAVAILABLE]: GrpcStatus.UNAVAILABLE,
};

/** Conflicts that mean "this already exists" rather than "wrong state". */
const ALREADY_EXISTS = new Set([
  ERROR.TENANT_SLUG_TAKEN.type,
  ERROR.TEMPLATE_NAME_TAKEN.type,
  ERROR.PROVIDER_NAME_TAKEN.type,
]);

/** The error shape grpc-js sends back to the client. */
export interface GrpcErrorPayload {
  code: GrpcStatus;
  details: string;
  message: string;
  metadata: Metadata;
}

/** Maps a thrown value to type/status/data. Exported for tests. */
export function describeError(exception: unknown): {
  type: string;
  status: number;
  data?: Record<string, unknown>;
  args?: Record<string, unknown>;
} | null {
  if (!(exception instanceof HttpException)) return null;
  const body = exception.getResponse();
  if (typeof body === 'object' && body !== null && 'type' in body) {
    const { type, data, args } = body as { type: string; data?: Record<string, unknown>; args?: Record<string, unknown> };
    return { type, status: exception.getStatus(), data, args };
  }
  return { type: HttpStatus[exception.getStatus()] ?? ERROR.BAD_REQUEST.type, status: exception.getStatus() };
}

/** gRPC code for a described error. */
export function grpcCode(type: string, status: number): GrpcStatus {
  if (status === HttpStatus.CONFLICT && ALREADY_EXISTS.has(type)) return GrpcStatus.ALREADY_EXISTS;
  return CODE_BY_STATUS[status] ?? GrpcStatus.INTERNAL;
}

@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter {
  private readonly logger = new Logger('RpcError');

  constructor(
    private readonly i18n: I18nService,
    private readonly metrics: MetricsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): Observable<never> {
    const described = describeError(exception);
    const incoming = host.getType() === 'rpc' ? host.switchToRpc().getContext<Metadata | undefined>() : undefined;
    const lang = incoming?.get?.(METADATA.LANGUAGE)?.[0]?.toString();

    const metadata = new Metadata();
    if (!described) {
      this.logger.error(exception);
      recordRpc(this.metrics, GrpcStatus.INTERNAL);
      metadata.set(METADATA.ERROR_TYPE, ERROR.INTERNAL_SERVER_ERROR.type);
      const details = translate(this.i18n, ERROR.INTERNAL_SERVER_ERROR.type, lang);
      return throwError(() => ({ code: GrpcStatus.INTERNAL, details, message: details, metadata }) satisfies GrpcErrorPayload);
    }

    const { type, status, data, args } = described;
    if (status >= 500) this.logger.error(exception);
    recordRpc(this.metrics, grpcCode(type, status));
    metadata.set(METADATA.ERROR_TYPE, type);
    if (data && Object.keys(data).length > 0) metadata.set(METADATA.ERROR_DATA, JSON.stringify(data));
    const details = translate(this.i18n, type, lang, args);
    return throwError(() => ({ code: grpcCode(type, status), details, message: details, metadata }) satisfies GrpcErrorPayload);
  }
}
