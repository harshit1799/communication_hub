/**
 * Root module: configuration, structured logging, i18n, infrastructure
 * (Postgres, Redis, BullMQ, encryption, metrics) and the feature modules,
 * plus the global gRPC guards, interceptor and exception filter.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { GrpcMetadataResolver, I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';
import { stdTimeFunctions } from 'pino';
import { AuthGuard } from './auth/auth.guard.js';
import { RateLimitGuard } from './auth/rate-limit.guard.js';
import { BootstrapModule } from './bootstrap/bootstrap.module.js';
import { AppConfig } from './config/configuration.js';
import { environment } from './config/environment.js';
import { METADATA } from './constant/index.js';
import { PostgresModule } from './database/postgres/postgres.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { RpcContextGuard, RpcContextInterceptor } from './grpc/rpc-context.js';
import { GrpcExceptionFilter } from './grpc/rpc-exception.filter.js';
import { DeviceModule } from './modules/device/device.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { ProviderModule } from './modules/provider/provider.module.js';
import { SenderModule } from './modules/sender/sender.module.js';
import { TemplateModule } from './modules/template/template.module.js';
import { TenantModule } from './modules/tenant/tenant.module.js';
import { CryptoModule } from './utils/crypto/crypto.module.js';
import { MetricsModule } from './utils/metrics/metrics.module.js';
import { QueueModule } from './utils/queue/queue.module.js';
import { RedisModule } from './utils/redis/redis.module.js';
import { RequestContextStore } from './utils/request-context.js';

// Distributed tracing, logs and metrics (https://observe.nestjs.com).
export const { ObserveModule, ObserveInstrument } = createObserveModule();

const appConfig = (config: ConfigService) => config.getOrThrow<AppConfig>('app');

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
    // One JSON object per line on stdout (pretty in development), collected
    // by Promtail into Loki. Every line carries service/role and, inside a
    // call or job, requestId / rpc / tenantId (see utils/request-context.ts).
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = appConfig(config);
        return {
          pinoHttp: {
            level: app.logLevel,
            base: { service: 'communication-hub', role: app.role, env: app.deployEnv },
            timestamp: stdTimeFunctions.isoTime,
            // "level":"warn" instead of 40: readable in Loki queries.
            formatters: { level: (label: string) => ({ level: label }) },
            mixin: () => {
              const ctx = RequestContextStore.current();
              return ctx ? { requestId: ctx.requestId, rpc: ctx.rpc, tenantId: ctx.tenantId } : {};
            },
            // Never write credentials or personal data to logs.
            redact: ['credentials', 'recipient', 'data', '*.credentials', '*.recipient', 'apiKey', 'key'],
            transport:
              app.env === 'development'
                ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard', singleLine: true } }
                : undefined,
          },
        };
      },
    }),
    // Translates error types into status messages (`language` metadata).
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: { path: join(import.meta.dirname, 'i18n'), watch: false },
      resolvers: [new GrpcMetadataResolver([METADATA.LANGUAGE])],
    }),
    ObserveModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        appKey: appConfig(config).observe.appKey,
        appSecret: appConfig(config).observe.appSecret,
        serviceId: 'communication_hub',
      }),
    }),
    CryptoModule,
    MetricsModule,
    RedisModule,
    PostgresModule,
    QueueModule,
    BootstrapModule,
    HealthModule,
    TenantModule,
    TemplateModule,
    SenderModule,
    ProviderModule,
    DeviceModule,
    InboxModule,
    NotificationModule,
    // HTTP/JSON + Swagger in front of the gRPC API.
    GatewayModule,
  ],
  providers: [
    // Guards run in this order: open the request context, authenticate,
    // then rate-limit per tenant.
    { provide: APP_GUARD, useClass: RpcContextGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RpcContextInterceptor },
    { provide: APP_FILTER, useClass: GrpcExceptionFilter },
  ],
})
export class AppModule {}
