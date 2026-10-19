/**
 * Global Redis module: one shared client for caching and rate limiting.
 * (BullMQ opens its own connections, see utils/queue.)
 */

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { createRedisConnection } from './redis.connection.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
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
    RedisThrottlerStorage,
  ],
  exports: [RedisService, RedisThrottlerStorage],
})
export class RedisModule {}
