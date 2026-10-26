/**
 * Rate limiting per tenant across every API replica (fixed window, counters
 * in Redis). Runs after AuthGuard, so the tenant is known; admin and public
 * RPCs are not limited. Fails open when Redis is unavailable.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Metadata } from '@grpc/grpc-js';
import { AppConfig } from '../config/configuration.js';
import { tenantOf } from '../decorator/tenant.decorator.js';
import { AppException } from '../exceptions/index.js';
import { ERROR } from '../response/response.js';
import { RedisRateLimiter } from '../utils/redis/redis-rate-limiter.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly limit: number;

  constructor(
    private readonly limiter: RedisRateLimiter,
    config: ConfigService,
  ) {
    const { throttle } = config.getOrThrow<AppConfig>('app');
    this.windowMs = throttle.ttlSeconds * 1000;
    this.limit = throttle.limit;
  }

  /** One hit per RPC; RESOURCE_EXHAUSTED over the limit. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'rpc') return true;
    const tenant = tenantOf(context.switchToRpc().getContext<Metadata>());
    if (!tenant) return true;
    const { hits, retryAfterSeconds } = await this.limiter.hit(`tenant:${tenant.tenantId}`, this.windowMs);
    if (hits > this.limit) throw new AppException(ERROR.TOO_MANY_REQUESTS, { retryAfterSeconds });
    return true;
  }
}
