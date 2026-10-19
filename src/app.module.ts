/**
 * Root module: configuration, logging, i18n, rate limiting, infrastructure
 * (Postgres, Redis, BullMQ) and the feature modules, plus the global guards,
 * interceptor and exception filter.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { seconds, ThrottlerModule } from '@nestjs/throttler';
import { AcceptLanguageResolver, HeaderResolver, I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';
import { AuthGuard } from './auth/auth.guard.js';
import { TenantThrottlerGuard } from './auth/tenant-throttler.guard.js';
import { BootstrapModule } from './bootstrap/bootstrap.module.js';
import { AppConfig } from './config/configuration.js';
import { environment } from './config/environment.js';
import { HEADER } from './constant/index.js';
import { PostgresModule } from './database/postgres/postgres.module.js';
import { HttpExceptionFilter } from './exceptions/index.js';
import { DeviceModule } from './modules/device/device.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { TenantModule } from './modules/tenant/tenant.module.js';
import { ResponseInterceptor } from './response/response.interceptor.js';
import { QueueModule } from './utils/queue/queue.module.js';
import { RedisModule } from './utils/redis/redis.module.js';
import { RedisThrottlerStorage } from './utils/redis/redis-throttler.storage.js';
import { resolveRequestId } from './utils/request-id.js';

// Distributed tracing, logs and metrics (https://observe.nestjs.com).
export const { ObserveModule, ObserveInstrument } = createObserveModule();

const appConfig = (config: ConfigService) => config.getOrThrow<AppConfig>('app');

/**
 * Root module. Import order matters only for documentation; Nest
 * resolves dependencies itself.
 */
@Module({
  imports: [
    // Like the backend: .env is read here, then the `environment` loader
    // fetches AWS Secrets Manager (outside APP_ENV=local), validates and
    // builds the typed `app` config. Everything below reads it via
    // ConfigService, so it always sees the final values.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [environment],
    }),
    // Structured JSON logs (pretty in development), with request ids.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = appConfig(config);
        return {
          pinoHttp: {
            level: app.logLevel,
            transport:
              app.env === 'development'
                ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard', singleLine: true } }
                : undefined,
            genReqId: (req, res) => {
              const id = resolveRequestId(req);
              res.setHeader(HEADER.REQUEST_ID, id);
              return id;
            },
            // Never write credentials to logs.
            redact: [
              `req.headers["${HEADER.API_KEY}"]`,
              `req.headers["${HEADER.ADMIN_KEY}"]`,
              'req.headers.authorization',
            ],
            // Probes would drown out real traffic.
            autoLogging: { ignore: (req) => req.url?.includes('/health') ?? false },
          },
        };
      },
    }),
    // Translates response `type` into `message` (language / Accept-Language headers).
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: { path: join(import.meta.dirname, 'i18n'), watch: false },
      resolvers: [{ use: HeaderResolver, options: [HEADER.LANGUAGE] }, AcceptLanguageResolver],
    }),
    RedisModule,
    // Per-tenant rate limit, counters shared through Redis.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => {
        const { throttle } = appConfig(config);
        return { throttlers: [{ ttl: seconds(throttle.ttlSeconds), limit: throttle.limit }], storage };
      },
    }),
    ObserveModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        appKey: appConfig(config).observe.appKey,
        appSecret: appConfig(config).observe.appSecret,
        serviceId: 'communication_hub',
      }),
    }),
    PostgresModule,
    QueueModule,
    BootstrapModule,
    HealthModule,
    TenantModule,
    DeviceModule,
    NotificationModule,
  ],
  providers: [
    // Guards run in this order: authenticate, then rate-limit per tenant.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
