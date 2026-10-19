/**
 * Root module of the application. It wires together configuration,
 * observability and all feature modules.
 */

// Module: decorator that marks a class as a Nest module.
import { Module } from '@nestjs/common';
// ConfigModule loads env/config; ConfigService reads values from it.
import { ConfigModule, ConfigService } from '@nestjs/config';
// APP_FILTER: special token to register a global exception filter via DI.
import { APP_FILTER } from '@nestjs/core';
// createObserveModule: factory for the NestJS Observe (telemetry) module.
import { createObserveModule } from '@nestjs/observe';
// Global filter that formats every error into a consistent JSON response.
import { AllExceptionsFilter } from './common/filters/http-exception.filter.js';
// configuration: function that builds the config object; AppConfig: its type.
import configuration, { AppConfig } from './config/configuration.js';
// validateEnv: validates environment variables at startup.
import { validateEnv } from './config/env.validation.js';
// PostgreSQL connection + migrations.
import { DatabaseModule } from './database/database.module.js';
// Feature module exposing the /health endpoint.
import { HealthModule } from './modules/health/health.module.js';
// Feature module containing all notification logic.
import { NotificationsModule } from './modules/notifications/notifications.module.js';

// Create the Observe module and its instrumentation hook (used in main.ts).
export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  // Modules whose providers/controllers become part of this application.
  imports: [
    // Load configuration once for the whole app.
    ConfigModule.forRoot({
      // Make ConfigService injectable everywhere without re-importing.
      isGlobal: true,
      // Cache values in memory for faster access.
      cache: true,
      // Register our typed configuration factory.
      load: [configuration],
      // Fail startup if environment variables are invalid.
      validate: validateEnv,
    }),
    // Distributed tracing, logs and metrics. Set OBSERVE_APP_KEY /
    // OBSERVE_APP_SECRET in .env to connect (https://observe.nestjs.com).
    ObserveModule.forRootAsync({
      // Inject ConfigService into the factory below.
      inject: [ConfigService],
      // Build Observe options from configuration at runtime.
      useFactory: (config: ConfigService) => {
        // Read the typed `app` config namespace.
        const app = config.getOrThrow<AppConfig>('app');
        // Return the credentials and service name for Observe.
        return {
          appKey: app.observe.appKey,
          appSecret: app.observe.appSecret,
          serviceId: 'communication_hub',
        };
      },
    }),
    // PostgreSQL connection (runs pending migrations on startup).
    DatabaseModule,
    // Health check endpoint.
    HealthModule,
    // Notification sending/listing endpoints.
    NotificationsModule,
  ],
  // Register AllExceptionsFilter globally through dependency injection.
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
// The root module class itself; Nest reads the decorator metadata above.
export class AppModule {}
