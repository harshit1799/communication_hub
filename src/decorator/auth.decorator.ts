/**
 * Route access levels, read by the global AuthGuard.
 *
 *   (no decorator)  tenant API key required (x-api-key)  <- the default
 *   @Public()       no credentials (health checks)
 *   @AdminOnly()    admin key required (x-admin-key)
 *
 * Secure by default: a new route is protected unless explicitly opened.
 */

import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';
import { SECURITY } from '../constant/index.js';

/** Who may call a route. */
export enum AccessLevel {
  Public = 'public',
  Tenant = 'tenant',
  Admin = 'admin',
}

/** Metadata key read by AuthGuard. */
export const ACCESS_LEVEL_KEY = 'access_level';

/** Route needs no credentials (health checks). */
export const Public = () => SetMetadata(ACCESS_LEVEL_KEY, AccessLevel.Public);

/** Route needs the x-admin-key header. Also documents it in Swagger. */
export const AdminOnly = () =>
  applyDecorators(
    SetMetadata(ACCESS_LEVEL_KEY, AccessLevel.Admin),
    ApiSecurity(SECURITY.ADMIN),
  );

/** Documents the tenant key in Swagger (the guard enforces it regardless). */
export const TenantAuth = () => ApiSecurity(SECURITY.TENANT);
