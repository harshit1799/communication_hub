/**
 * Delivery guarantees, one section per user story. Runs against real
 * PostgreSQL and Redis (see vitest.config.e2e.ts).
 *
 *   1. Idempotency-Key: retrying a request never sends the same message twice
 *   2. Priority: a login OTP is delivered before a queued campaign
 *   3. Retries: temporary provider errors are retried with backoff
 *   4. Crash safety: a crash between the DB write and the queue push loses nothing
 */

import { ConfigService } from '@nestjs/config';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp, createFastifyAdapter } from '../src/app.setup.js';
import { AppConfig } from '../src/config/configuration.js';
import { MAINTENANCE_JOB, NotificationPriority } from '../src/constant/index.js';
import { MaintenanceProcessor } from '../src/modules/notification/maintenance.processor.js';
import { NotificationQueue } from '../src/modules/notification/notification.queue.js';
import { buildDefaultJobOptions } from '../src/utils/queue/queue.module.js';

/** Admin header matching ADMIN_API_KEY in vitest.config.e2e.ts. */
const ADMIN = { 'x-admin-key': 'e2e-admin-key-0123456789abcdef0123456789' };

/** Redis connection for the standalone queue tests (same server as the app). */
const redis = { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) };

describe('Delivery guarantees (e2e)', () => {
  let app: NestFastifyApplication;
  let tenant: { 'x-api-key': string };

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    options: { headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    const res = await app.inject({ method, url, headers: options.headers, payload: options.body as object });
    return { status: res.statusCode, body: res.json(), headers: res.headers };
  };

  /** Polls until the notification has left the in-flight states. */
  const waitForFinalStatus = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await call('GET', `/api/v1/notifications/${id}`, { headers: tenant });
      if (!['queued', 'processing', 'retrying'].includes(body.data.status)) return body.data;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`notification ${id} did not finish`);
  };

  /** A new tenant with its own API key. */
  const createTenant = async () => {
    const { body } = await call('POST', '/api/v1/admin/tenants', {
      headers: ADMIN,
      body: { name: 'Guarantees', slug: `e2e-${randomUUID().slice(0, 8)}` },
    });
    return { 'x-api-key': body.data.apiKey.key as string };
  };

  const otp = (code: string) => ({ channel: 'sms', recipient: '+14155550123', template: 'otp', data: { code } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const config = moduleRef.get(ConfigService).getOrThrow<AppConfig>('app');
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(config.bodyLimit));
    await configureApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    tenant = await createTenant();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('1. Idempotency-Key: retrying never sends the same OTP twice', () => {
    it('a retried request returns the original notification and is not sent again', async () => {
      const headers = { ...tenant, 'idempotency-key': `otp-${randomUUID()}` };
      const first = await call('POST', '/api/v1/notifications', { headers, body: otp('111111') });
      // The client "retries" (e.g. after a timeout), even with a different body.
      const retry = await call('POST', '/api/v1/notifications', { headers, body: otp('999999') });

      expect(first.status).toBe(202);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.status).toBe(202);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(retry.body.data.data).toEqual({ code: '111111' });

      const done = await waitForFinalStatus(first.body.data.id);
      expect(done.status).toBe('sent');
      // Exactly one delivery attempt: the OTP went out once.
      expect(done.attemptLog).toHaveLength(1);
    });

    it('concurrent retries with the same key create one notification and one send', async () => {
      const headers = { ...tenant, 'idempotency-key': `otp-${randomUUID()}` };
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => call('POST', '/api/v1/notifications', { headers, body: otp('222222') })),
      );
      const ids = new Set(responses.map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);

      const [id] = ids;
      const [{ count }] = await app
        .get(DataSource)
        .query('SELECT count(*)::int AS count FROM notifications WHERE idempotency_key = $1', [headers['idempotency-key']]);
      expect(count).toBe(1);
      expect((await waitForFinalStatus(id)).attemptLog).toHaveLength(1);
    });

    it('accepts the key in the body too, and rejects a header/body mismatch', async () => {
      const key = `otp-${randomUUID()}`;
      const viaBody = await call('POST', '/api/v1/notifications', { headers: tenant, body: { ...otp('1'), idempotencyKey: key } });
      const viaHeader = await call('POST', '/api/v1/notifications', {
        headers: { ...tenant, 'idempotency-key': key },
        body: otp('1'),
      });
      expect(viaHeader.body.data.id).toBe(viaBody.body.data.id);

      const mismatch = await call('POST', '/api/v1/notifications', {
        headers: { ...tenant, 'idempotency-key': 'a' },
        body: { ...otp('1'), idempotencyKey: 'b' },
      });
      expect(mismatch).toMatchObject({ status: 422, body: { type: 'IDEMPOTENCY_KEY_MISMATCH' } });

      const tooLong = await call('POST', '/api/v1/notifications', {
        headers: { ...tenant, 'idempotency-key': 'x'.repeat(256) },
        body: otp('1'),
      });
      expect(tooLong).toMatchObject({ status: 400, body: { type: 'IDEMPOTENCY_KEY_INVALID' } });
    });

    it('scopes keys per tenant (two tenants may use the same key)', async () => {
      const key = `shared-${randomUUID()}`;
      const other = await createTenant();
      const a = await call('POST', '/api/v1/notifications', { headers: { ...tenant, 'idempotency-key': key }, body: otp('1') });
      const b = await call('POST', '/api/v1/notifications', { headers: { ...other, 'idempotency-key': key }, body: otp('1') });
      expect(a.body.data.id).not.toBe(b.body.data.id);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('2. Priority: a login OTP is delivered before a running campaign', () => {
    it('defaults: single sends are normal, bulk (campaign) sends are low', async () => {
      const single = await call('POST', '/api/v1/notifications', { headers: tenant, body: otp('1') });
      const bulk = await call('POST', '/api/v1/notifications/bulk', {
        headers: tenant,
        body: { notifications: [{ channel: 'sms', recipient: '+14155550100', body: 'Sale!' }] },
      });
      expect(single.body.data.priority).toBe(NotificationPriority.Normal);
      expect(bulk.body.data.notifications[0].priority).toBe(NotificationPriority.Low);
    });

    it('an OTP enqueued behind a 200-message campaign is processed first', async () => {
      // A dedicated queue on the real Redis, filled through the real producer.
      const suffix = randomUUID().slice(0, 8);
      const connection = { ...redis, maxRetriesPerRequest: null };
      const queue = new Queue(`e2e-priority-${suffix}`, { connection, prefix: 'chub-e2e-test' });
      const producer = new NotificationQueue(queue, queue, queue);

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
      const options = buildDefaultJobOptions({ attempts: 4, backoffMs: 200, stuckAfterMinutes: 2, workers: {} as never });
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
      const queue = app.get(NotificationQueue);
      const enqueue = vi.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('Redis connection lost'));

      const res = await call('POST', '/api/v1/notifications', { headers: tenant, body: otp('333333') });
      expect(res.status).toBe(202);
      expect(enqueue).toHaveBeenCalledTimes(1);
      enqueue.mockRestore();

      // Durably stored, but no job exists: without recovery it would be lost.
      const id = res.body.data.id as string;
      await new Promise((r) => setTimeout(r, 300));
      expect((await call('GET', `/api/v1/notifications/${id}`, { headers: tenant })).body.data.status).toBe('queued');

      // The row is older than the sweeper threshold; run the sweeper's tick.
      await app.get(DataSource).query(`UPDATE notifications SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]);
      await app.get(MaintenanceProcessor).process({ name: MAINTENANCE_JOB.REQUEUE_STUCK } as Job);

      const done = await waitForFinalStatus(id);
      expect(done.status).toBe('sent');
      expect(done.attemptLog).toHaveLength(1);
    });

    it('the sweeper never enqueues a notification twice', async () => {
      const res = await call('POST', '/api/v1/notifications', { headers: tenant, body: otp('444444') });
      const id = res.body.data.id as string;
      await waitForFinalStatus(id);
      // Even if a delivered row looked stale, sweeping it does not resend it.
      await app.get(DataSource).query(`UPDATE notifications SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]);
      await app.get(MaintenanceProcessor).process({ name: MAINTENANCE_JOB.REQUEUE_STUCK } as Job);
      await new Promise((r) => setTimeout(r, 300));
      expect((await waitForFinalStatus(id)).attemptLog).toHaveLength(1);
    });
  });
});
