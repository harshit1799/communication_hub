/**
 * `@CurrentTenant()` injects the tenant resolved from the API key, e.g.
 * `send(@CurrentTenant() tenant: TenantContext) { ... }`.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantSettings } from '../models/tenant.model.js';

/** What the AuthGuard attaches to the request after validating a key. */
export interface TenantContext {
  tenantId: string;
  apiKeyId: string;
  name: string;
  slug: string;
  settings: TenantSettings;
}

/** The request shape after AuthGuard has run. */
export interface TenantRequest {
  tenant?: TenantContext;
}

/** Parameter decorator returning the authenticated tenant. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const tenant = ctx.switchToHttp().getRequest<TenantRequest>().tenant;
    // Guaranteed by AuthGuard on tenant routes; fail loudly if misused.
    if (!tenant) throw new Error('@CurrentTenant() used on a non-tenant route');
    return tenant;
  },
);
