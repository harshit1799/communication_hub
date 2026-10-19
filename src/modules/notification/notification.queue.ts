/**
 * Producer side of the delivery queues. A job's id is the notification id,
 * so BullMQ itself de-duplicates: enqueueing the same notification twice
 * while a job exists is a no-op.
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import { CHANNEL_QUEUE, NotificationChannel, QUEUE_PRIORITY } from '../../constant/index.js';
import { Notification } from '../../models/index.js';

/** Payload of a delivery job. Postgres holds everything else. */
export interface NotificationJob {
  notificationId: string;
  // Correlates worker logs with the HTTP request that created the job.
  requestId?: string;
}

/** The notification fields needed to build a job. */
type Enqueueable = Pick<Notification, 'id' | 'channel' | 'priority' | 'scheduledAt'>;

/** Wraps the three channel queues behind one API. */
@Injectable()
export class NotificationQueue {
  private readonly queues: Record<NotificationChannel, Queue<NotificationJob>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUE.email) email: Queue<NotificationJob>,
    @InjectQueue(CHANNEL_QUEUE.sms) sms: Queue<NotificationJob>,
    @InjectQueue(CHANNEL_QUEUE.push) push: Queue<NotificationJob>,
  ) {
    this.queues = {
      [NotificationChannel.Email]: email,
      [NotificationChannel.Sms]: sms,
      [NotificationChannel.Push]: push,
    };
  }

  /** Enqueues notifications in one round trip per channel. */
  async enqueue(notifications: Enqueueable[], requestId?: string): Promise<void> {
    const byChannel = new Map<NotificationChannel, Enqueueable[]>();
    for (const n of notifications) {
      byChannel.set(n.channel, [...(byChannel.get(n.channel) ?? []), n]);
    }
    await Promise.all(
      [...byChannel].map(([channel, items]) =>
        this.queues[channel].addBulk(
          items.map((n) => ({
            name: channel,
            data: { notificationId: n.id, requestId },
            opts: this.jobOptions(n),
          })),
        ),
      ),
    );
  }

  /**
   * Makes sure a job exists for the notification. A finished job left over
   * in Redis (completed/failed) is replaced, otherwise BullMQ would ignore
   * the new one because of the shared id.
   */
  async ensureEnqueued(n: Enqueueable, requestId?: string): Promise<void> {
    const queue = this.queues[n.channel];
    const job = await queue.getJob(n.id);
    if (job) {
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await job.remove();
    }
    await queue.add(n.channel, { notificationId: n.id, requestId }, this.jobOptions(n));
  }

  /** Removes a waiting/delayed job. Active jobs are locked and stay. */
  async remove(n: Enqueueable): Promise<void> {
    const job = await this.queues[n.channel].getJob(n.id);
    await job?.remove().catch(() => undefined);
  }

  /** Every queue, for health checks and metrics. */
  all(): Queue<NotificationJob>[] {
    return Object.values(this.queues);
  }

  /** Job id = notification id (dedup), priority, and delay for scheduled sends. */
  private jobOptions(n: Enqueueable): JobsOptions {
    return {
      jobId: n.id,
      priority: QUEUE_PRIORITY[n.priority],
      delay: n.scheduledAt ? Math.max(0, n.scheduledAt.getTime() - Date.now()) : undefined,
    };
  }
}
