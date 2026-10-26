/**
 * Global Redis module: one shared client for caching (API keys, providers,
 * senders, templates) and rate limiting.
 * (BullMQ opens its own connections, see utils/queue.)
 */

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { createRedisConnection } from './redis.connection.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';
import { REDIS_CLIENT, RedisService } from './redis.service.js';

/** Global so any module can inject RedisService without importing this. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createRedisConnection(config.getOrThrow<AppConfig>('app').redis, {
          // Fail fast: callers fall back to Postgres / fail open.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    RedisService,
    RedisRateLimiter,
  ],
  exports: [RedisService, RedisRateLimiter],
})
export class RedisModule {}
