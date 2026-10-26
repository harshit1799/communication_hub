/**
 * `@CurrentTenant()` injects the tenant resolved from the API key into a
 * gRPC handler, e.g. `send(@Payload() req, @CurrentTenant() tenant: TenantContext)`.
 * AuthGuard attaches it to the call's metadata object.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import type { TenantSettings } from '../models/tenant.model.js';

/** What the AuthGuard attaches to the call after validating a key. */
export interface TenantContext {
  tenantId: string;
  apiKeyId: string;
  name: string;
  slug: string;
  settings: TenantSettings;
}

// Keyed by the call's Metadata instance: lives exactly as long as the call.
const tenants = new WeakMap<object, TenantContext>();

/** Called by AuthGuard once the key is valid. */
export function attachTenant(metadata: Metadata, tenant: TenantContext): void {
  tenants.set(metadata, tenant);
}

/** The authenticated tenant of a call, if any. */
export function tenantOf(metadata: Metadata | undefined): TenantContext | undefined {
  return metadata ? tenants.get(metadata) : undefined;
}

/** Parameter decorator returning the authenticated tenant. */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = tenantOf(ctx.switchToRpc().getContext<Metadata>());
  // Guaranteed by AuthGuard on tenant services; fail loudly if misused.
  if (!tenant) throw new Error('@CurrentTenant() used on a non-tenant RPC');
  return tenant;
});
