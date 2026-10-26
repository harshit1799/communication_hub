/**
 * Per-call context (request id, RPC method, tenant) carried through async
 * code with AsyncLocalStorage. The logger adds it to every line written
 * while handling the call (app.module.ts, pino `mixin`), so Loki can filter
 * all logs of one request: {service="hub-api"} | json | requestId="...".
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  // "NotificationService/SendNotification"
  rpc?: string;
  tenantId?: string;
  // process.hrtime.bigint() at call start (latency metrics).
  startedAt?: bigint;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Accepted format for caller-supplied ids; anything else is replaced (log safety). */
const SAFE_ID = /^[\w.-]{1,128}$/;

export const RequestContextStore = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },
  /**
   * Sets the context for the rest of the current async chain. Used by the
   * first gRPC guard: each call runs in its own chain (one per HTTP/2
   * stream), so the context can't leak into another call.
   */
  enter(context: RequestContext): void {
    storage.enterWith(context);
  },
  current(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Adds fields to the current context (e.g. tenantId once authenticated). */
  assign(fields: Partial<RequestContext>): void {
    const ctx = storage.getStore();
    if (ctx) Object.assign(ctx, fields);
  },
};

/** The caller's id if it looks safe, otherwise a new UUID. */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}
