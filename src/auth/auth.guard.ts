/**
 * Global authentication guard. Every route requires a tenant API key unless
 * marked @Public() or @AdminOnly() (see decorator/auth.decorator.ts).
 *
 *   x-api-key: chk_...      tenant routes; resolves and attaches the tenant
 *   x-admin-key: <secret>   admin routes (ADMIN_API_KEY)
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppConfig } from '../config/configuration.js';
import { HEADER } from '../constant/index.js';
import { ACCESS_LEVEL_KEY, AccessLevel } from '../decorator/auth.decorator.js';
import { TenantRequest } from '../decorator/tenant.decorator.js';
import { AppException } from '../exceptions/index.js';
import { ApiKeyService } from '../modules/tenant/api-key.service.js';
import { ERROR } from '../response/response.js';
import { safeEqual } from '../utils/appUtils.js';

/** Registered globally (APP_GUARD) in AppModule, before the rate limiter. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly adminApiKey?: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
  ) {
    this.adminApiKey = config.getOrThrow<AppConfig>('app').auth.adminApiKey;
  }

  /**
   * Applies the route's access level. Tenant routes get `request.tenant`
   * attached for @CurrentTenant(). Throws 401/403 AppExceptions on failure.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only HTTP requests carry credentials.
    if (context.getType() !== 'http') return true;

    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? AccessLevel.Tenant;
    const request = context.switchToHttp().getRequest<FastifyRequest & TenantRequest>();

    switch (level) {
      case AccessLevel.Public:
        return true;
      case AccessLevel.Admin:
        return this.checkAdmin(request);
      default:
        request.tenant = await this.apiKeys.resolve(this.header(request, HEADER.API_KEY, ERROR.API_KEY_MISSING));
        return true;
    }
  }

  /**
   * Compares the admin key in constant time. Admin routes are disabled
   * (403) when ADMIN_API_KEY is not configured.
   */
  private checkAdmin(request: FastifyRequest): boolean {
    if (!this.adminApiKey) throw new AppException(ERROR.ADMIN_DISABLED);
    const key = this.header(request, HEADER.ADMIN_KEY, ERROR.ADMIN_KEY_INVALID);
    if (!safeEqual(key, this.adminApiKey)) throw new AppException(ERROR.ADMIN_KEY_INVALID);
    return true;
  }

  /** Reads a required, non-empty header or throws the given error. */
  private header(request: FastifyRequest, name: string, error: typeof ERROR.API_KEY_MISSING) {
    const value = request.headers[name];
    if (typeof value !== 'string' || !value.trim()) throw new AppException(error);
    return value.trim();
  }
}
