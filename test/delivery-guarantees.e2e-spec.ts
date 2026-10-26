/**
 * Delivery guarantees, one section per user story. Runs against real
 * PostgreSQL and Redis over gRPC (see vitest.config.e2e.ts).
 *
 *   1. Idempotency key: retrying a request never sends the same message twice
 *   2. Priority: a login OTP is delivered before a queued campaign
 *   3. Retries: temporary provider errors are retried with backoff
 *   4. Crash safety: a crash between the DB write and the queue push loses nothing
 */

import { status } from '@grpc/grpc-js';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { MAINTENANCE_JOB, NotificationPriority } from '../src/constant/index.js';
import { MaintenanceProcessor } from '../src/modules/notification/maintenance.processor.js';
import { NotificationQueue } from '../src/modules/notification/notification.queue.js';
import { MetricsService } from '../src/utils/metrics/metrics.service.js';
import { buildDefaultJobOptions } from '../src/utils/queue/queue.module.js';
import { Hub, startHub, struct, unstruct } from './support/grpc-hub.js';

/** Redis connection for the standalone queue tests (same server as the app). */
const redis = { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) };

describe('Delivery guarantees (e2e)', () => {
  let hub: Hub;
  let key: string;

  const otp = (code: string, extra: object = {}) => ({
    channel: 'CHANNEL_SMS',
    recipient: '+14155550123',
    template: 'otp',
    data: struct({ code }),
    ...extra,
  });
  const send = (notification: object, apiKey = key) =>
    hub.call('NotificationService', 'SendNotification', { notification }, hub.tenant(apiKey));

  beforeAll(async () => {
    hub = await startHub();
    ({ key } = await hub.createTenant());
  });

  afterAll(async () => {
    await hub?.close();
  });

  describe('1. Idempotency key: retrying never sends the same OTP twice', () => {
    it('a retried request returns the original notification and is not sent again', async () => {
      const idempotencyKey = `otp-${randomUUID()}`;
      const first = await send(otp('111111', { idempotencyKey }));
      // The client "retries" (e.g. after a deadline), even with a different body.
      const retry = await send(otp('999999', { idempotencyKey }));

      expect(first.replayed).toBe(false);
      expect(retry.replayed).toBe(true);
      expect(retry.notification.id).toBe(first.notification.id);
      expect(unstruct(retry.notification.data)).toEqual({ code: '111111' });

      const done = await hub.waitForFinal(key, first.notification.id);
      expect(done.notification.status).toBe('NOTIFICATION_STATUS_SENT');
      // Exactly one delivery attempt: the OTP went out once.
      expect(done.attempts).toHaveLength(1);
    });

    it('concurrent retries with the same key create one notification and one send', async () => {
      const idempotencyKey = `otp-${randomUUID()}`;
      const responses = await Promise.all(Array.from({ length: 10 }, () => send(otp('222222', { idempotencyKey }))));
      const ids = new Set(responses.map((r) => r.notification.id));
      expect(ids.size).toBe(1);
      expect(responses.filter((r) => r.replayed)).toHaveLength(9);

      const [id] = ids;
      const [{ count }] = await hub.moduleRef
        .get(DataSource)
        .query('SELECT count(*)::int AS count FROM notifications WHERE idempotency_key = $1', [idempotencyKey]);
      expect(count).toBe(1);
      expect((await hub.waitForFinal(key, id)).attempts).toHaveLength(1);
    });

    it('rejects an over-long key', async () => {
      await hub.expectError(send(otp('1', { idempotencyKey: 'x'.repeat(256) })), status.INVALID_ARGUMENT, 'VALIDATION_ERROR');
    });

    it('scopes keys per tenant (two tenants may use the same key)', async () => {
      const idempotencyKey = `shared-${randomUUID()}`;
      const other = await hub.createTenant();
      const a = await send(otp('1', { idempotencyKey }));
      const b = await send(otp('1', { idempotencyKey }), other.key);
      expect(a.notification.id).not.toBe(b.notification.id);
      expect(b.replayed).toBe(false);
    });
  });

  describe('2. Priority: a login OTP is delivered before a running campaign', () => {
    it('defaults: single sends are normal, bulk (campaign) sends are low', async () => {
      const single = await send(otp('1'));
      const bulk = await hub.call(
        'NotificationService',
        'SendBulkNotifications',
        { notifications: [{ channel: 'CHANNEL_SMS', recipient: '+14155550100', body: 'Sale!' }] },
        hub.tenant(key),
      );
      expect(single.notification.priority).toBe('PRIORITY_NORMAL');
      expect(bulk.notifications[0].priority).toBe('PRIORITY_LOW');
    });

    it('an OTP enqueued behind a 200-message campaign is processed first', async () => {
      // A dedicated queue on the real Redis, filled through the real producer.
      const suffix = randomUUID().slice(0, 8);
      const connection = { ...redis, maxRetriesPerRequest: null };
      const queue = new Queue(`e2e-priority-${suffix}`, { connection, prefix: 'chub-e2e-test' });
      const producer = new NotificationQueue(queue, queue, queue, queue, new MetricsService());

      const campaign = Array.from({ length: 200 }, () => ({
        id: randomUUID(),
        channel: 'sms' as const,
        priority: NotificationPriority.Low,
        scheduledAt: null,
      }));
      await producer.enqueue(campaign as never);
      const loginOtp = { id: randomUUID(), channel: 'sms' as const, priority: NotificationPriority.High, scheduledAt: null };
      await producer.enqueue([loginOtp] as never);
      const regular = { id: randomUUID(), channel: 'sms' as const, priority: NotificationPriority.Normal, scheduledAt: null };
      await producer.enqueue([regular] as never);

      const order: string[] = [];
      const worker = new Worker(
        queue.name,
        async (job: Job) => {
          order.push(job.data.notificationId);
        },
        { connection, prefix: 'chub-e2e-test', concurrency: 1 },
      );
      while (order.length < 202) await new Promise((r) => setTimeout(r, 50));
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();

      // The OTP first, then the normal send, then the campaign.
      expect(order[0]).toBe(loginOtp.id);
      expect(order[1]).toBe(regular.id);
    });
  });

  describe('3. Retries: temporary provider errors are retried with backoff', () => {
    /** Runs one job through a worker with the app's real job options. */
    const runJob = async (processor: (job: Job) => Promise<void>) => {
      const suffix = randomUUID().slice(0, 8);
      const connection = { ...redis, maxRetriesPerRequest: null };
      const options = buildDefaultJobOptions({ attempts: 4, backoffMs: 200, stuckAfterMinutes: 2, workers: {} as never, inboxRetentionDays: 90 });
      const queue = new Queue(`e2e-retry-${suffix}`, { connection, prefix: 'chub-e2e-test', defaultJobOptions: options });
      const attemptTimes: number[] = [];
      const worker = new Worker(
        queue.name,
        async (job: Job) => {
          attemptTimes.push(Date.now());
          await processor(job);
        },
        { connection, prefix: 'chub-e2e-test' },
      );
      const job = await queue.add('send', {});
      const finished = new Promise<'completed' | 'failed'>((resolve) => {
        worker.on('completed', () => resolve('completed'));
        worker.on('failed', (j, _err) => {
          if (j && (j.attemptsMade >= (j.opts.attempts ?? 1) || j.finishedOn)) resolve('failed');
        });
      });
      const outcome = await finished;
      const state = await queue.getJob(job.id!);
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      return { outcome, attemptTimes, attemptsMade: state?.attemptsMade };
    };

    it('retries a temporary error with growing, jittered delays until it succeeds', async () => {
      let calls = 0;
      const { outcome, attemptTimes } = await runJob(async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNRESET (provider hiccup)');
      });
      expect(outcome).toBe('completed');
      expect(attemptTimes).toHaveLength(3);
      // Exponential backoff from 200ms with 50% jitter: ~100-200ms, then ~200-400ms.
      const [first, second] = [attemptTimes[1] - attemptTimes[0], attemptTimes[2] - attemptTimes[1]];
      expect(first).toBeGreaterThanOrEqual(90);
      expect(second).toBeGreaterThanOrEqual(190);
    });

    it('does not retry permanent errors (e.g. invalid number)', async () => {
      const { outcome, attemptTimes } = await runJob(async () => {
        throw new UnrecoverableError('21211: invalid To number');
      });
      expect(outcome).toBe('failed');
      expect(attemptTimes).toHaveLength(1);
    });
  });

  describe('4. Crash safety: nothing is lost between the DB write and the queue push', () => {
    it('a notification whose queue push failed is still accepted and later delivered', async () => {
      // Simulate a crash/Redis failure right after the DB commit.
      const queue = hub.moduleRef.get(NotificationQueue);
      const enqueue = vi.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('Redis connection lost'));

      const res = await send(otp('333333'));
      expect(res.notification.status).toBe('NOTIFICATION_STATUS_QUEUED');
      expect(enqueue).toHaveBeenCalledTimes(1);
      enqueue.mockRestore();

      // Durably stored, but no job exists: without recovery it would be lost.
      const id = res.notification.id as string;
      await new Promise((r) => setTimeout(r, 300));
      const stored = await hub.call('NotificationService', 'GetNotification', { id }, hub.tenant(key));
      expect(stored.notification.status).toBe('NOTIFICATION_STATUS_QUEUED');

      // The row is older than the sweeper threshold; run the sweeper's tick.
      await hub.moduleRef.get(DataSource).query(`UPDATE notifications SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]);
      await hub.moduleRef.get(MaintenanceProcessor).process({ name: MAINTENANCE_JOB.REQUEUE_STUCK } as Job);

      const done = await hub.waitForFinal(key, id);
      expect(done.notification.status).toBe('NOTIFICATION_STATUS_SENT');
      expect(done.attempts).toHaveLength(1);
    });

    it('the sweeper never enqueues a notification twice', async () => {
      const res = await send(otp('444444'));
      const id = res.notification.id as string;
      await hub.waitForFinal(key, id);
      // Even if a delivered row looked stale, sweeping it does not resend it.
      await hub.moduleRef.get(DataSource).query(`UPDATE notifications SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]);
      await hub.moduleRef.get(MaintenanceProcessor).process({ name: MAINTENANCE_JOB.REQUEUE_STUCK } as Job);
      await new Promise((r) => setTimeout(r, 300));
      expect((await hub.waitForFinal(key, id)).attempts).toHaveLength(1);
    });
  });
});
