/**
 * Application entry point.
 *
 * How everything is linked:
 *
 *   AppModule
 *     ConfigModule.forRoot({ load: [environment] })    config/environment.ts
 *       .env, then AWS Secrets Manager (utils/secretManager.ts, fetchSecrets)
 *       when APP_ENV is development | staging | preprod | production,
 *       then validation; the result is ConfigService's `app` config
 *     PostgresModule, RedisModule, QueueModule, CryptoModule, ...
 *       connect using ConfigService; each logs when it is ready
 *   server()
 *     api / all: gRPC server on GRPC_PORT (proto/communication_hub/v1/*.proto)
 *     worker:    queue workers only, no gRPC port
 *     every role: ops HTTP on OPS_PORT (/health/live, /health/ready, /metrics)
 *
 * APP_ROLE (a container variable, like APP_ENV) decides what runs:
 *   api     gRPC API only (scale on request rate)
 *   worker  queue workers only (scale on queue depth)
 *   all     both (default; convenient locally)
 */

import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule, ObserveInstrument } from './app.module.js';
import { AppConfig, readRole } from './config/configuration.js';
import { AppRole } from './constant/index.js';
import { buildGrpcOptions } from './grpc/grpc.options.js';

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

/** Starts the process in its role: exactly one application instance either way. */
async function server() {
  // Worker role: queue workers (started by WorkerLifecycle) + ops port only.
  if (readRole() === AppRole.Worker) {
    const worker = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true, instrument: ObserveInstrument });
    const logger = worker.get(Logger);
    worker.useLogger(logger);
    enableGracefulShutdown(worker, logger);
    const config = worker.get(ConfigService).getOrThrow<AppConfig>('app');
    logger.log(`${config.name} worker started (${config.deployEnv})`, 'Bootstrap');
    return;
  }

  // API (or all-in-one): the gRPC server. Options come from ConfigService,
  // i.e. after .env + Secrets Manager + validation.
  const grpc = await NestFactory.createMicroservice(AppModule, {
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => buildGrpcOptions(configService.getOrThrow<AppConfig>('app')),
    bufferLogs: true,
    instrument: ObserveInstrument,
  });
  const logger = grpc.get(Logger);
  grpc.useLogger(logger);
  enableGracefulShutdown(grpc, logger);
  const config = grpc.get(ConfigService).getOrThrow<AppConfig>('app');
  await grpc.listen();
  logger.log(
    `${config.name} (${config.role}, ${config.deployEnv}) serving gRPC on :${config.grpc.port}` +
      (config.grpc.reflection ? ' (reflection on)' : ''),
    'Bootstrap',
  );
}

await server();
