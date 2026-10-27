/**
 * Maintenance jobs, run through BullMQ job schedulers (exactly one worker
 * in the cluster runs each tick):
 *
 *   requeue-stuck  every minute: the self-healing sweeper below
 *   purge-inbox    hourly: deletes expired in-app inbox messages
 *
 * Self-healing sweeper:
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
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { InboxService } from '../inbox/inbox.service.js';
import { NotificationQueue } from './notification.queue.js';
import { NotificationRepository } from './notification.repository.js';
import { RetryPolicyService } from './retry-policy.service.js';

/** Consumes the maintenance queue (worker processes only). */
@Processor(MAINTENANCE_QUEUE, { autorun: false })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private readonly stuckAfterMs: number;

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly queue: NotificationQueue,
    private readonly metrics: MetricsService,
    private readonly inbox: InboxService,
    private readonly retryPolicies: RetryPolicyService,
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
  async process(job: Job): Promise<{ requeued?: number; purged?: number }> {
    if (job.name === MAINTENANCE_JOB.PURGE_INBOX) return { purged: await this.purgeInbox() };
    if (job.name !== MAINTENANCE_JOB.REQUEUE_STUCK) return {};

    const stuck = await this.notifications.claimStuck(
      new Date(Date.now() - this.stuckAfterMs),
      LIMITS.SWEEP_BATCH,
    );
    let requeued = 0;
    for (const n of stuck) {
      try {
        await this.queue.ensureEnqueued(n, undefined, await this.retryPolicies.forNotification(n));
        requeued++;
      } catch (err) {
        this.logger.error(`Could not re-enqueue ${n.id}: ${errorMessage(err)}`);
      }
    }
    this.metrics.requeued.inc(requeued);
    if (stuck.length > 0) this.logger.warn({ msg: `Re-checked ${stuck.length} stuck notifications`, event: 'sweeper_requeued', count: stuck.length });
    return { requeued };
  }

  /** Deletes expired inbox messages (INBOX_RETENTION_DAYS). */
  private async purgeInbox(): Promise<number> {
    const purged = await this.inbox.purgeExpired();
    this.metrics.inboxPurged.inc(purged);
    if (purged > 0) this.logger.log({ msg: `Purged ${purged} expired inbox messages`, event: 'inbox_purged', count: purged });
    return purged;
  }
}
