/**
 * Application entry point.
 * This file creates the NestJS application, applies global configuration,
 * mounts Swagger documentation and starts the HTTP server.
 */

// Logger: Nest's built-in logger, used to print startup messages.
import { Logger } from '@nestjs/common';
// ConfigService: reads the typed configuration loaded by ConfigModule.
import { ConfigService } from '@nestjs/config';
// NestFactory: the factory that builds a Nest application from a root module.
import { NestFactory } from '@nestjs/core';
// AppModule: root module of the app; ObserveInstrument: tracing hook for NestJS Observe.
import { AppModule, ObserveInstrument } from './app.module.js';
// configureApp: shared global setup (pipes, prefix, versioning, security).
import { configureApp } from './app.setup.js';
// setupSwagger: builds the OpenAPI document and serves the Swagger UI.
import { setupSwagger } from './common/swagger/setup-swagger.js';
// AppConfig: TypeScript shape of the `app` configuration namespace.
import { AppConfig } from './config/configuration.js';

/**
 * Boots the application. Declared async because creating the app and
 * listening on a port are both asynchronous operations.
 */
async function bootstrap() {
  // Create the Nest application (Express under the hood) from the root module.
  const app = await NestFactory.create(AppModule, {
    // Attach the Observe instrumentation so requests are traced automatically.
    instrument: ObserveInstrument,
  });

  // Read the validated `app` config; getOrThrow fails fast if it is missing.
  const config = app.get(ConfigService).getOrThrow<AppConfig>('app');

  // Apply global middleware, pipes, API prefix and versioning.
  configureApp(app, config);

  // Only expose Swagger when enabled (e.g. disable it in production via env).
  if (config.swagger.enabled) {
    // Mount Swagger UI at /<SWAGGER_PATH> with the app name as the title.
    setupSwagger(app, {
      path: config.swagger.path,
      title: config.name,
      version: '1.0',
    });
  }

  // Start the HTTP server on the configured port.
  await app.listen(config.port);

  // Resolve the actual URL the server is bound to (host + port).
  const url = await app.getUrl();
  // Create a logger with the "Bootstrap" context label.
  const logger = new Logger('Bootstrap');
  // Print the base URL of the API.
  logger.log(`${config.name} running on ${url}/${config.apiPrefix}`);
  // Print the Swagger URL when the docs are enabled.
  if (config.swagger.enabled) {
    logger.log(`Swagger UI available at ${url}/${config.swagger.path}`);
  }
}

// Top-level await (allowed because the project is an ES module) starts the app.
await bootstrap();
