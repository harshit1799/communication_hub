/**
 * Per-call bookkeeping for the gRPC API: request context, one log line and
 * Prometheus metrics (method, status code, latency) per call.
 *
 *   RpcContextGuard        first global guard: opens the request context
 *                          (x-request-id or a new id, RPC name, start time)
 *                          so even auth failures are correlated and counted
 *   RpcContextInterceptor  records successful calls
 *   GrpcExceptionFilter    records failed calls (recordRpc)
 */

import { CanActivate, CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Observable, tap } from 'rxjs';
import { METADATA } from '../constant/index.js';
import { MetricsService } from '../utils/metrics/metrics.service.js';
import { RequestContextStore, resolveRequestId } from '../utils/request-context.js';

// Where @nestjs/microservices stores @GrpcMethod(service, rpc) on a handler.
const PATTERN_METADATA = 'microservices:pattern';

/** "NotificationService/SendNotification" for a handler. */
function rpcName(context: ExecutionContext): string {
  const [pattern] = (Reflect.getMetadata(PATTERN_METADATA, context.getHandler()) ?? []) as { service?: string; rpc?: string }[];
  return pattern?.service ? `${pattern.service}/${pattern.rpc}` : `${context.getClass().name}.${context.getHandler().name}`;
}

const logger = new Logger('Rpc');

/** Records one finished call (metrics + access log). Called on success and on error. */
export function recordRpc(metrics: MetricsService, code: GrpcStatus): void {
  const ctx = RequestContextStore.current();
  if (!ctx?.rpc || ctx.startedAt === undefined) return;
  const seconds = Number(process.hrtime.bigint() - ctx.startedAt) / 1e9;
  const name = GrpcStatus[code];
  metrics.rpcRequests.inc({ method: ctx.rpc, code: name });
  metrics.rpcDuration.observe({ method: ctx.rpc }, seconds);
  const fields = { event: 'rpc', code: name, durationMs: Math.round(seconds * 1000) };
  if (code === GrpcStatus.OK) logger.log({ msg: `${ctx.rpc} OK`, ...fields });
  else logger.warn({ msg: `${ctx.rpc} ${name}`, ...fields });
}

/** Opens the request context for the call. Never rejects. */
@Injectable()
export class RpcContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;
    const metadata = context.switchToRpc().getContext<Metadata>();
    RequestContextStore.enter({
      requestId: resolveRequestId(metadata?.get(METADATA.REQUEST_ID)?.[0]),
      rpc: rpcName(context),
      startedAt: process.hrtime.bigint(),
    });
    return true;
  }
}

/** Records successful calls; failures are recorded by GrpcExceptionFilter. */
@Injectable()
export class RpcContextInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    return next.handle().pipe(tap({ complete: () => recordRpc(this.metrics, GrpcStatus.OK) }));
  }
}
