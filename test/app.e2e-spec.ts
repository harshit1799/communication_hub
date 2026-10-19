/**
 * End-to-end tests. Boots the full application (API + workers) on Fastify
 * in memory and sends real HTTP requests with fastify.inject(). Needs a
 * running PostgreSQL and Redis; the test database is created by
 * `createdb communication_hub_test` (see vitest.config.e2e.ts).
 */

import { ConfigService } from '@nestjs/config';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp, createFastifyAdapter } from '../src/app.setup.js';
import { AppConfig } from '../src/config/configuration.js';

/** Admin header matching ADMIN_API_KEY in vitest.config.e2e.ts. */
const ADMIN = { 'x-admin-key': 'e2e-admin-key-0123456789abcdef0123456789' };

describe('Communication Hub (e2e)', () => {
  let app: NestFastifyApplication;
  // A fresh tenant per run, so runs never see each other's data.
  let tenant: { 'x-api-key': string };

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, options: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const res = await app.inject({ method, url, headers: options.headers, payload: options.body as object });
    return { status: res.statusCode, body: res.json(), headers: res.headers };
  };

  /** Polls until the worker has moved the notification out of in-flight states. */
  const waitForFinalStatus = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const { body } = await call('GET', `/api/v1/notifications/${id}`, { headers: tenant });
      if (!['queued', 'processing', 'retrying'].includes(body.data.status)) return body.data;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`notification ${id} did not finish`);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const config = moduleRef.get(ConfigService).getOrThrow<AppConfig>('app');
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(config.bodyLimit));
    await configureApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const { body } = await call('POST', '/api/v1/admin/tenants', {
      headers: ADMIN,
      body: { name: 'E2E', slug, settings: { appName: 'E2E Brand' } },
    });
    tenant = { 'x-api-key': body.data.apiKey.key };
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/health and /api/health/ready', async () => {
    expect((await call('GET', '/api/health')).body.data.status).toBe('ok');
    const ready = await call('GET', '/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ database: 'up', redis: 'up' });
  });

  it('requires an API key and rejects unknown ones', async () => {
    const missing = await call('POST', '/api/v1/notifications', { body: {} });
    expect(missing).toMatchObject({ status: 401, body: { type: 'API_KEY_MISSING' } });
    const invalid = await call('GET', '/api/v1/notifications', { headers: { 'x-api-key': 'chk_nope' } });
    expect(invalid.body.type).toBe('API_KEY_INVALID');
  });

  it('protects admin routes', async () => {
    const res = await call('GET', '/api/v1/admin/tenants', { headers: tenant });
    expect(res).toMatchObject({ status: 401, body: { type: 'ADMIN_KEY_INVALID' } });
  });

  it('validates the payload per channel', async () => {
    const res = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'sms', recipient: '4155550123', body: 'hi' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ type: 'VALIDATION_ERROR' });
    expect(res.body.message).toContain('E.164');
  });

  it('rejects unknown templates before storing anything', async () => {
    const res = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'email', recipient: 'a@b.com', subject: 'Hi', template: 'nope' },
    });
    expect(res).toMatchObject({ status: 400, body: { type: 'TEMPLATE_NOT_FOUND' } });
  });

  it('accepts an email, delivers it in the worker and records the attempt', async () => {
    const res = await call('POST', '/api/v1/notifications', {
      headers: { ...tenant, 'x-request-id': 'e2e-req-1' },
      body: { channel: 'email', recipient: 'jane@example.com', subject: 'Code {{code}}', template: 'otp', data: { code: '123456' } },
    });
    expect(res.status).toBe(202);
    expect(res.headers['x-request-id']).toBe('e2e-req-1');
    expect(res.body).toMatchObject({ type: 'NOTIFICATION_ACCEPTED', data: { status: 'queued' } });

    const done = await waitForFinalStatus(res.body.data.id);
    expect(done).toMatchObject({ status: 'sent', attempts: 1, provider: 'console' });
    expect(done.attemptLog).toHaveLength(1);

    const [row] = await app
      .get(DataSource)
      .query('SELECT status, sent_at IS NOT NULL AS has_sent_at FROM notifications WHERE id = $1', [done.id]);
    expect(row).toEqual({ status: 'sent', has_sent_at: true });
  });

  it('is idempotent per idempotency key', async () => {
    const body = { channel: 'sms', recipient: '+14155550123', body: 'once', idempotencyKey: `k-${randomUUID()}` };
    const first = await call('POST', '/api/v1/notifications', { headers: tenant, body });
    const second = await call('POST', '/api/v1/notifications', { headers: tenant, body: { ...body, body: 'twice?' } });
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.body).toBe('once');
  });

  it('sends in bulk, keeping request order and resolving duplicates', async () => {
    const key = `k-${randomUUID()}`;
    const original = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'sms', recipient: '+14155550100', body: 'a', idempotencyKey: key },
    });
    const res = await call('POST', '/api/v1/notifications/bulk', {
      headers: tenant,
      body: {
        notifications: [
          { channel: 'sms', recipient: '+14155550100', body: 'a', idempotencyKey: key },
          { channel: 'sms', recipient: '+14155550101', body: 'b' },
          { channel: 'email', recipient: 'c@example.com', subject: 's', body: 'c' },
        ],
      },
    });
    expect(res.status).toBe(202);
    const items = res.body.data.notifications;
    expect(items.map((n: { recipient: string }) => n.recipient)).toEqual(['+14155550100', '+14155550101', 'c@example.com']);
    expect(items[0].id).toBe(original.body.data.id);
    expect(new Set(items.map((n: { id: string }) => n.id)).size).toBe(3);
  });

  it('pushes to every registered device of a user', async () => {
    await call('POST', '/api/v1/devices', { headers: tenant, body: { userId: 'u-1', token: `tok-${randomUUID()}`, platform: 'android' } });
    const res = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'push', userId: 'u-1', subject: 'Hi', template: 'welcome', data: { name: 'Jane' } },
    });
    expect((await waitForFinalStatus(res.body.data.id)).status).toBe('sent');
  });

  it('fails permanently without retries when a user has no devices, and can be retried', async () => {
    const res = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'push', userId: 'nobody', body: 'hi' },
    });
    const failed = await waitForFinalStatus(res.body.data.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.attemptLog[0].permanent).toBe(true);

    await call('POST', '/api/v1/devices', { headers: tenant, body: { userId: 'nobody', token: `tok-${randomUUID()}`, platform: 'ios' } });
    const retried = await call('POST', `/api/v1/notifications/${failed.id}/retry`, { headers: tenant });
    expect(retried.status).toBe(202);
    expect((await waitForFinalStatus(failed.id)).status).toBe('sent');
  });

  it('cancels a scheduled notification', async () => {
    const res = await call('POST', '/api/v1/notifications', {
      headers: tenant,
      body: { channel: 'sms', recipient: '+14155550123', body: 'later', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const cancelled = await call('POST', `/api/v1/notifications/${res.body.data.id}/cancel`, { headers: tenant });
    expect(cancelled.body.data.status).toBe('cancelled');
    const again = await call('POST', `/api/v1/notifications/${res.body.data.id}/cancel`, { headers: tenant });
    expect(again).toMatchObject({ status: 409, body: { type: 'NOTIFICATION_NOT_CANCELLABLE' } });
  });

  it('paginates with a cursor', async () => {
    const first = await call('GET', '/api/v1/notifications?limit=2', { headers: tenant });
    expect(first.body.data.data).toHaveLength(2);
    const second = await call('GET', `/api/v1/notifications?limit=2&cursor=${first.body.data.nextCursor}`, { headers: tenant });
    const ids = (page: { body: { data: { data: { id: string }[] } } }) => page.body.data.data.map((n) => n.id);
    expect(ids(second).some((id: string) => ids(first).includes(id))).toBe(false);
  });

  it('isolates tenants and revokes keys immediately', async () => {
    const other = await call('POST', '/api/v1/admin/tenants', {
      headers: ADMIN,
      body: { name: 'Other', slug: `e2e-${randomUUID().slice(0, 8)}` },
    });
    const otherKey = { 'x-api-key': other.body.data.apiKey.key };
    const mine = await call('GET', '/api/v1/notifications?limit=1', { headers: tenant });
    const peek = await call('GET', `/api/v1/notifications/${mine.body.data.data[0].id}`, { headers: otherKey });
    expect(peek.status).toBe(404);

    const { id } = other.body.data.tenant;
    await call('DELETE', `/api/v1/admin/tenants/${id}/api-keys/${other.body.data.apiKey.id}`, { headers: ADMIN });
    expect((await call('GET', '/api/v1/notifications', { headers: otherKey })).status).toBe(401);
  });
});
