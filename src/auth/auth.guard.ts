/**
 * Global authentication guard for the gRPC API. Every RPC requires a tenant
 * API key unless its service is marked @Public() or @AdminOnly() (see
 * decorator/auth.decorator.ts).
 *
 *   x-api-key: chk_...      tenant services; resolves and attaches the tenant
 *   x-admin-key: <secret>   admin services (ADMIN_API_KEY)
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Metadata } from '@grpc/grpc-js';
import { AppConfig } from '../config/configuration.js';
import { METADATA } from '../constant/index.js';
import { ACCESS_LEVEL_KEY, AccessLevel } from '../decorator/auth.decorator.js';
import { attachTenant } from '../decorator/tenant.decorator.js';
import { AppException } from '../exceptions/index.js';
import { ApiKeyService } from '../modules/tenant/api-key.service.js';
import { ERROR, ErrorDefinition } from '../response/response.js';
import { safeEqual } from '../utils/appUtils.js';
import { RequestContextStore } from '../utils/request-context.js';

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

  /** Applies the RPC's access level. Throws UNAUTHENTICATED / PERMISSION_DENIED. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Queue workers and other non-RPC contexts carry no credentials.
    if (context.getType() !== 'rpc') return true;

    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_LEVEL_KEY, [context.getHandler(), context.getClass()]) ??
      AccessLevel.Tenant;
    const metadata = context.switchToRpc().getContext<Metadata>();

    switch (level) {
      case AccessLevel.Public:
        return true;
      case AccessLevel.Admin:
        return this.checkAdmin(metadata);
      default: {
        const tenant = await this.apiKeys.resolve(this.read(metadata, METADATA.API_KEY, ERROR.API_KEY_MISSING));
        attachTenant(metadata, tenant);
        RequestContextStore.assign({ tenantId: tenant.tenantId });
        return true;
      }
    }
  }

  /** Constant-time admin key check; admin RPCs are disabled without ADMIN_API_KEY. */
  private checkAdmin(metadata: Metadata): boolean {
    if (!this.adminApiKey) throw new AppException(ERROR.ADMIN_DISABLED);
    const key = this.read(metadata, METADATA.ADMIN_KEY, ERROR.ADMIN_KEY_INVALID);
    if (!safeEqual(key, this.adminApiKey)) throw new AppException(ERROR.ADMIN_KEY_INVALID);
    return true;
  }

  /** A required, non-empty metadata value or the given error. */
  private read(metadata: Metadata, key: string, error: ErrorDefinition): string {
    const value = metadata?.get(key)?.[0];
    if (typeof value !== 'string' || !value.trim()) throw new AppException(error);
    return value.trim();
  }
}
