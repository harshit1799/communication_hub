/**
 * Application entry point, same shape as the backend's main.ts: one
 * `server()` function that creates the app, applies the global setup,
 * mounts Swagger and starts listening.
 *
 * How everything is linked:
 *
 *   AppModule
 *     ConfigModule.forRoot({ load: [environment] })    config/environment.ts
 *       .env, then AWS Secrets Manager (utils/secretManager.ts, fetchSecrets)
 *       when APP_ENV is development | staging | preprod | production,
 *       then validation; the result is ConfigService's `app` config
 *     PostgresModule, RedisModule, QueueModule, providers, ...
 *       connect using ConfigService; each logs when it is ready
 *   server()
 *     create the app -> configureApp (app.setup.ts) -> Swagger -> listen
 *
 * APP_ROLE (a container variable, like APP_ENV) decides what runs:
 *   api     HTTP API only (scale on request rate)
 *   worker  queue workers only, no HTTP port (scale on queue depth)
 *   all     both (default; convenient locally)
 */

import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp, createFastifyAdapter } from './app.setup.js';
import { AppConfig, readRole } from './config/configuration.js';
import { AppRole } from './constant/index.js';
import { SwaggerConfig } from './swagger/index.js';

/**
 * Last-resort shutdown deadline. Nest's shutdown hooks normally finish in
 * well under a second (workers finish their jobs, connections close). If a
 * dependency is unreachable, library close() calls can wait forever; the
 * process then exits on its own, logging why, before the orchestrator's
 * SIGKILL (Kubernetes default grace period: 30s).
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

/** Enables graceful shutdown on SIGTERM/SIGINT, bounded by the deadline above. */
function enableGracefulShutdown(app: INestApplicationContext, logger: Logger) {
  app.enableShutdownHooks();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        logger.error(`Shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms after ${signal}; exiting`, 'Shutdown');
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS).unref();
    });
  }
}

/** Starts the process in its role. */
async function server() {
  // Worker role: queue workers only, no HTTP server.
  if (readRole() === AppRole.Worker) {
    const worker = await NestFactory.createApplicationContext(AppModule, {
      bufferLogs: true,
      instrument: ObserveInstrument,
    });
    const logger = worker.get(Logger);
    worker.useLogger(logger);
    enableGracefulShutdown(worker, logger);
    const config = worker.get(ConfigService).getOrThrow<AppConfig>('app');
    logger.log(`${config.name} worker started (${config.deployEnv})`, 'Bootstrap');
    return;
  }

  // API (or all-in-one): Fastify app; connections log as they come up.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    bufferLogs: true,
    instrument: ObserveInstrument,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  enableGracefulShutdown(app, logger);

  // Final configuration (after .env + Secrets Manager + validation).
  const config = app.get(ConfigService).getOrThrow<AppConfig>('app');

  // Security headers, CORS, prefix, versioning, validation; Swagger.
  await configureApp(app, config);
  if (config.swagger.enabled) SwaggerConfig.setup(app, config);

  // Listen on 0.0.0.0 so the port is reachable inside containers.
  await app.listen(config.port, '0.0.0.0');
  const url = `http://localhost:${config.port}`;
  logger.log(`${config.name} (${config.role}, ${config.deployEnv}) running on ${url}/${config.apiPrefix}`, 'Bootstrap');
  if (config.swagger.enabled) logger.log(`Swagger UI: ${url}/${config.swagger.path}`, 'Bootstrap');
}

await server();
