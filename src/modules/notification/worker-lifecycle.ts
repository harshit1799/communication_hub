/**
 * Starts and stops the BullMQ workers.
 *
 * Start: the processors are registered with `autorun: false`, so nothing is
 * consumed until onApplicationBootstrap, when ConfigService holds the final
 * configuration (.env + Secrets Manager). In the `worker` and `all` roles
 * each worker gets its concurrency/rate limit and starts. In the `api` role
 * the workers are closed right away, releasing their Redis connections.
 *
 * Stop: on SIGTERM (deploys, scale-down) Nest runs every
 * beforeApplicationShutdown hook before any onApplicationShutdown hook. The
 * Postgres pool and Redis clients close in onApplicationShutdown, so closing
 * the workers here lets in-flight deliveries finish AND record their result
 * while those connections are still open. Otherwise a message could be sent
 * but not recorded, and then sent again on retry. The graceful close is
 * bounded; unfinished jobs are force-closed and retried later.
 *
 * worker.close() is idempotent, so @nestjs/bullmq closing the same workers
 * later is harmless.
 */

import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { AppRole } from '../../constant/index.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { EmailProcessor, PushProcessor, SmsProcessor } from './notification.processor.js';

// Below main.ts's 25s shutdown deadline, leaving time to close connections.
const GRACEFUL_CLOSE_MS = 15_000;

@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Workers');
  private readonly app: AppConfig;

  constructor(
    private readonly email: EmailProcessor,
    private readonly sms: SmsProcessor,
    private readonly push: PushProcessor,
    private readonly maintenance: MaintenanceProcessor,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
  }

  private get hosts() {
    return [this.email, this.sms, this.push, this.maintenance];
  }

  /** Starts the workers in worker/all roles; releases them in the api role. */
  async onApplicationBootstrap() {
    if (this.app.role === AppRole.Api) {
      await Promise.all(this.hosts.map((host) => host.worker.close()));
      this.logger.log('APP_ROLE=api: queue workers disabled (run APP_ROLE=worker to consume queues)');
      return;
    }
    const { workers } = this.app.queue;
    this.email.start(workers.email);
    this.sms.start(workers.sms);
    this.push.start(workers.push);
    this.maintenance.start();
  }

  /** Stops taking new jobs and waits (bounded) for the active ones to finish. */
  async beforeApplicationShutdown(signal?: string) {
    if (this.app.role === AppRole.Api) return;
    const shutdown = new Logger('Shutdown');
    shutdown.log(`${signal ?? 'Shutdown'} received: finishing in-flight jobs before closing connections`);
    const started = Date.now();
    const graceful = Promise.all(this.hosts.map((host) => host.worker.close())).then(() => true);
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), GRACEFUL_CLOSE_MS).unref());

    if (await Promise.race([graceful, timedOut])) {
      shutdown.log(`All workers stopped in ${Date.now() - started}ms`);
      return;
    }
    shutdown.warn(`Workers did not stop within ${GRACEFUL_CLOSE_MS}ms; force-closing (unfinished jobs will be retried)`);
    await Promise.all(this.hosts.map((host) => host.worker.close(true).catch(() => undefined)));
  }
}
