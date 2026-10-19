/**
 * Rate limiting per tenant (falls back to client IP on routes without a
 * tenant). Runs after AuthGuard, so the tenant is already resolved. Counters
 * live in Redis, so the limit holds across all API replicas.
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TenantRequest } from '../decorator/tenant.decorator.js';

/** Registered globally (APP_GUARD) after AuthGuard. */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  /**
   * Who the request is counted against: the tenant, or the client IP
   * on public routes.
   */
  protected getTracker(req: Record<string, any>): Promise<string> {
    const tenant = (req as TenantRequest).tenant;
    return Promise.resolve(tenant ? `tenant:${tenant.tenantId}` : `ip:${req.ip}`);
  }

  // The default key also includes the route, which would give every
  // endpoint its own budget. One budget per tenant across the whole API.
  protected generateKey(_context: ExecutionContext, tracker: string, throttlerName: string): string {
    return `${throttlerName}:${tracker}`;
  }
}
