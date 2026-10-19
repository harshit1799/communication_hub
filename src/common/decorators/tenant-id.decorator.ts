/**
 * `@TenantId()` parameter decorator.
 * Use it in a controller method to get the current tenant id, e.g.
 * `send(@TenantId() tenantId: string) { ... }`.
 */

// BadRequestException: produces an HTTP 400 response.
// createParamDecorator: helper to build custom route parameter decorators.
// ExecutionContext: gives access to the current request.
import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
// Express Request type (type-only import, removed at compile time).
import type { Request } from 'express';
// Header name used to carry the tenant id.
import { TENANT_HEADER } from '../constants.js';

/**
 * Resolves the white-label tenant for the current request from the
 * `x-tenant-id` header. Swap this for API-key / JWT based resolution later.
 */
export const TenantId = createParamDecorator(
  // `_data` would hold an argument passed to the decorator (unused here).
  (_data: unknown, ctx: ExecutionContext): string => {
    // Get the underlying Express request object.
    const request = ctx.switchToHttp().getRequest<Request>();
    // Read the header and remove surrounding whitespace (undefined if absent).
    const tenantId = request.header(TENANT_HEADER)?.trim();
    // Reject the request if no tenant id was supplied.
    if (!tenantId) {
      throw new BadRequestException(
        `Missing required header: ${TENANT_HEADER}`,
      );
    }
    // The returned value is injected into the decorated parameter.
    return tenantId;
  },
);
