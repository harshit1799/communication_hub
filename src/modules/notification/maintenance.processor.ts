/**
 * Self-healing sweeper, run every minute through a BullMQ job scheduler.
 * Because it is a queue job, exactly one worker in the cluster runs it per
 * tick, however many replicas there are.
 *
 * It re-enqueues notifications stuck in an in-flight state: the row was
 * saved but enqueueing failed (Redis blip), or Redis lost the job. Jobs
 * that still exist are left alone (ensureEnqueued is a no-op for them).
 */

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AppConfig } from '../../config/configuration.js';
import { LIMITS, MAINTENANCE_JOB, MAINTENANCE_QUEUE } from '../../constant/index.js';
import { errorMessage } from '../../utils/appUtils.js';
import { ConnectionState } from '../../utils/connection-state.js';
import { NotificationQueue } from './notification.queue.js';
import { NotificationRepository } from './notification.repository.js';

/** Consumes the maintenance queue (worker processes only). */
@Processor(MAINTENANCE_QUEUE, { autorun: false })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private readonly stuckAfterMs: number;

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly queue: NotificationQueue,
    config: ConfigService,
  ) {
    super();
    this.stuckAfterMs = config.getOrThrow<AppConfig>('app').queue.stuckAfterMinutes * 60_000;
  }

  private readonly connection = new ConnectionState(this.logger, `Worker "${MAINTENANCE_QUEUE}"`);

  /** Starts taking jobs (called by WorkerLifecycle in worker/all roles). */
  start(): void {
    this.logger.log(`Worker started, consuming "${this.worker.name}" (stuck-notification sweeper)`);
    this.worker.run().catch((err: Error) => this.logger.error(`Worker stopped unexpectedly: ${err.message}`));
  }

  /** The worker's Redis connection is up again after an outage. */
  @OnWorkerEvent('ready')
  onReady() {
    this.connection.ready();
  }

  /** Connection errors (one warning per outage); without a listener they would crash the process. */
  @OnWorkerEvent('error')
  onError(err: Error) {
    this.connection.error(err);
  }

  /**
   * Re-enqueues up to LIMITS.SWEEP_BATCH stuck notifications. One
   * failing row is logged and skipped, so it can't block the rest.
   */
  async process(job: Job): Promise<{ requeued: number }> {
    if (job.name !== MAINTENANCE_JOB.REQUEUE_STUCK) return { requeued: 0 };

    const stuck = await this.notifications.claimStuck(
      new Date(Date.now() - this.stuckAfterMs),
      LIMITS.SWEEP_BATCH,
    );
    let requeued = 0;
    for (const n of stuck) {
      try {
        await this.queue.ensureEnqueued(n);
        requeued++;
      } catch (err) {
        this.logger.error(`Could not re-enqueue ${n.id}: ${errorMessage(err)}`);
      }
    }
    if (stuck.length > 0) this.logger.warn(`Re-checked ${stuck.length} stuck notifications`);
    return { requeued };
  }
}
