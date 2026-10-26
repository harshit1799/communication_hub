/**
 * RPC access levels, read by the global AuthGuard. Put them on the
 * controller (one gRPC service) or on a single method.
 *
 *   (no decorator)  tenant API key required (x-api-key)  <- the default
 *   @Public()       no credentials (health checks)
 *   @AdminOnly()    admin key required (x-admin-key)
 *
 * Secure by default: a new RPC is protected unless explicitly opened.
 */

import { SetMetadata } from '@nestjs/common';

/** Who may call an RPC. */
export enum AccessLevel {
  Public = 'public',
  Tenant = 'tenant',
  Admin = 'admin',
}

/** Metadata key read by AuthGuard. */
export const ACCESS_LEVEL_KEY = 'access_level';

/** RPC needs no credentials (health checks). */
export const Public = () => SetMetadata(ACCESS_LEVEL_KEY, AccessLevel.Public);

/** RPC needs the x-admin-key metadata. */
export const AdminOnly = () => SetMetadata(ACCESS_LEVEL_KEY, AccessLevel.Admin);
