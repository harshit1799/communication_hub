/**
 * End-to-end tests over gRPC. Boots the full application (gRPC server +
 * workers) and calls it with a real gRPC client built from proto/. Needs a
 * running PostgreSQL and Redis; the test database is created by
 * `createdb communication_hub_test` (see vitest.config.e2e.ts).
 */

import { status } from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Hub, Msg, startHub, struct, timestamp, unstruct } from './support/grpc-hub.js';

describe('Communication Hub over gRPC (e2e)', () => {
  let hub: Hub;
  // A fresh tenant per run, so runs never see each other's data.
  let key: string;

  const send = (notification: object, extra?: Record<string, string>) =>
    hub.call('NotificationService', 'SendNotification', { notification }, hub.tenant(key, extra));

  beforeAll(async () => {
    hub = await startHub();
    ({ key } = await hub.createTenant({ appName: 'E2E Brand' }));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('requires an API key and rejects unknown ones', async () => {
    await hub.expectError(hub.call('NotificationService', 'ListNotifications', {}), status.UNAUTHENTICATED, 'API_KEY_MISSING');
    await hub.expectError(hub.call('NotificationService', 'ListNotifications', {}, hub.tenant('chk_nope')), status.UNAUTHENTICATED, 'API_KEY_INVALID');
  });

  it('protects admin services', async () => {
    await hub.expectError(hub.call('TenantAdminService', 'ListTenants', {}, hub.tenant(key)), status.UNAUTHENTICATED, 'ADMIN_KEY_INVALID');
  });

  it('validates the payload per channel', async () => {
    const err = await hub.expectError(
      send({ channel: 'CHANNEL_SMS', recipient: '4155550123', body: 'hi' }),
      status.INVALID_ARGUMENT,
      'VALIDATION_ERROR',
    );
    expect(err.details).toContain('E.164');
    expect(JSON.parse(err.metadata.get('error-data')[0] as string).errors[0]).toContain('E.164');
  });

  it('rejects unknown templates before storing anything', async () => {
    await hub.expectError(
      send({ channel: 'CHANNEL_EMAIL', recipient: 'a@b.com', subject: 'Hi', template: 'nope' }),
      status.NOT_FOUND,
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('accepts an email, delivers it with the starter template and records the attempt', async () => {
    const res = await send(
      { channel: 'CHANNEL_EMAIL', recipient: 'jane@example.com', subject: 'Code {{code}}', template: 'otp', data: struct({ code: '123456' }) },
      { 'x-request-id': 'e2e-req-1' },
    );
    expect(res).toMatchObject({ replayed: false, notification: { status: 'NOTIFICATION_STATUS_QUEUED', templateVersion: 1 } });

    const { notification, attempts } = await hub.waitForFinal(key, res.notification.id);
    expect(notification).toMatchObject({ status: 'NOTIFICATION_STATUS_SENT', attempts: 1, provider: 'console' });
    expect(attempts).toHaveLength(1);

    const [row] = await hub.moduleRef
      .get(DataSource)
      .query('SELECT status, sent_at IS NOT NULL AS has_sent_at FROM notifications WHERE id = $1', [notification.id]);
    expect(row).toEqual({ status: 'sent', has_sent_at: true });
  });

  it('stores recipients and data encrypted, and finds them through the blind index', async () => {
    const recipient = `secret-${randomUUID().slice(0, 6)}@Example.com`;
    const res = await send({ channel: 'CHANNEL_EMAIL', recipient, subject: 'Hi', body: 'Code {{code}}', data: struct({ code: '987654' }) });

    const [row] = await hub.moduleRef
      .get(DataSource)
      .query('SELECT recipient, recipient_hash, data FROM notifications WHERE id = $1', [res.notification.id]);
    expect(row.recipient).toMatch(/^enc:v1:e2e:/);
    expect(row.recipient).not.toContain('secret');
    expect(row.data).toMatch(/^enc:v1:e2e:/);
    expect(row.data).not.toContain('987654');
    expect(row.recipient_hash).toMatch(/^[0-9a-f]{64}$/);

    // Reads decrypt; lookups by recipient work (case-insensitively for email).
    expect(res.notification.recipient).toBe(recipient);
    expect(unstruct(res.notification.data)).toEqual({ code: '987654' });
    const found = await hub.call('NotificationService', 'ListNotifications', { recipient: recipient.toLowerCase() }, hub.tenant(key));
    expect(found.notifications.map((n: { id: string }) => n.id)).toEqual([res.notification.id]);
  });

  it('returns the queue state and attempts with every send', async () => {
    const res = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'queued', priority: 'PRIORITY_HIGH', idempotencyKey: `q-${randomUUID()}` });
    expect(res.attempts).toEqual([]);
    expect(res.queue).toMatchObject({ queue: 'notifications-sms', jobId: res.notification.id, priority: 1, maxAttempts: 5 });
    expect(['waiting', 'prioritized', 'active', 'completed']).toContain(res.queue.state);

    // After delivery: a replay carries the attempt history; Get shows the live job.
    const { notification } = await hub.waitForFinal(key, res.notification.id);
    const replay = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'queued', idempotencyKey: notification.idempotencyKey });
    expect(replay).toMatchObject({ replayed: true, attempts: [{ attempt: 1, success: true }] });
    const got = await hub.call('NotificationService', 'GetNotification', { id: notification.id }, hub.tenant(key));
    expect(got.queue).toMatchObject({ state: 'completed', attemptsMade: 1 });

    // Scheduled: delayed until scheduledAt.
    const at = new Date(Date.now() + 3_600_000);
    const later = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'later', scheduledAt: timestamp(at) });
    expect(later.queue).toMatchObject({ state: 'delayed', priority: 5 });
    expect(Math.abs(Number(later.queue.runAt.seconds) - Math.floor(at.getTime() / 1000))).toBeLessThanOrEqual(1);
    await hub.call('NotificationService', 'CancelNotification', { id: later.notification.id }, hub.tenant(key));
  });

  it('is idempotent per idempotency key', async () => {
    const notification = { channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'once', idempotencyKey: `k-${randomUUID()}` };
    const first = await send(notification);
    const second = await send({ ...notification, body: 'twice?' });
    expect(second).toMatchObject({ replayed: true, notification: { id: first.notification.id, body: 'once' } });
  });

  it('sends in bulk, keeping request order and resolving duplicates', async () => {
    const idempotencyKey = `k-${randomUUID()}`;
    const original = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550100', body: 'a', idempotencyKey });
    const res = await hub.call(
      'NotificationService',
      'SendBulkNotifications',
      {
        notifications: [
          { channel: 'CHANNEL_SMS', recipient: '+14155550100', body: 'a', idempotencyKey },
          { channel: 'CHANNEL_SMS', recipient: '+14155550101', body: 'b' },
          { channel: 'CHANNEL_EMAIL', recipient: 'c@example.com', subject: 's', body: 'c' },
        ],
      },
      hub.tenant(key),
    );
    expect(res).toMatchObject({ accepted: 3, replayed: 1 });
    expect(res.notifications.map((n: { recipient: string }) => n.recipient)).toEqual(['+14155550100', '+14155550101', 'c@example.com']);
    expect(res.notifications[0].id).toBe(original.notification.id);
    expect(new Set(res.notifications.map((n: { id: string }) => n.id)).size).toBe(3);
  });

  it('fans out one bulk item to several recipients, each with its own notification', async () => {
    const idempotencyKey = `k-${randomUUID()}`;
    const bulk = () =>
      hub.call(
        'NotificationService',
        'SendBulkNotifications',
        {
          notifications: [
            { channel: 'CHANNEL_EMAIL', recipient: 'a@example.com, b@example.com', subject: 's', body: 'hi', idempotencyKey },
            { channel: 'CHANNEL_SMS', recipients: ['+14155550110', '+14155550111'], body: 'hi' },
            { channel: 'CHANNEL_PUSH', userIds: ['u-a', 'u-b'], body: 'hi' },
          ],
        },
        hub.tenant(key),
      );
    const res = await bulk();
    expect(res).toMatchObject({ accepted: 6, replayed: 0 });
    expect(res.notifications.map((n: { recipient?: string; userId?: string }) => n.recipient ?? n.userId)).toEqual([
      'a@example.com',
      'b@example.com',
      '+14155550110',
      '+14155550111',
      'u-a',
      'u-b',
    ]);
    // The per-recipient idempotency keys make the whole request safe to repeat.
    const again = await bulk();
    expect(again.replayed).toBe(2);
    expect(again.notifications.slice(0, 2).map((n: { id: string }) => n.id)).toEqual(res.notifications.slice(0, 2).map((n: { id: string }) => n.id));

    await hub.expectError(
      send({ channel: 'CHANNEL_SMS', recipients: ['+14155550110', '+14155550111'], body: 'hi' }),
      status.INVALID_ARGUMENT,
      'VALIDATION_ERROR',
    );
  });

  it('rejects a bulk request listing more than 500 targets before expanding it', async () => {
    const recipients = Array.from({ length: 501 }, (_, i) => `+1415555${String(i).padStart(4, '0')}`);
    await hub.expectError(
      hub.call('NotificationService', 'SendBulkNotifications', { notifications: [{ channel: 'CHANNEL_SMS', recipients, body: 'hi' }] }, hub.tenant(key)),
      status.INVALID_ARGUMENT,
      'VALIDATION_ERROR',
    );
  });

  it('rejects bulk items the fan-out cannot split, naming the client item', async () => {
    const bulk = (notifications: object[]) => hub.call('NotificationService', 'SendBulkNotifications', { notifications }, hub.tenant(key));
    const errorOf = async (notifications: object[]) => (await hub.expectError(bulk(notifications), status.INVALID_ARGUMENT, 'VALIDATION_ERROR')).details;
    const ok = { channel: 'CHANNEL_SMS', recipients: ['+14155550130', '+14155550131', '+14155550132'], body: 'hi' };

    // Several recipients and several userIds in one item.
    expect(await errorOf([ok, { channel: 'CHANNEL_PUSH', recipients: ['t1', 't2'], userIds: ['u1', 'u2'], body: 'hi' }])).toContain('notifications.1');
    // A key with no room for the per-target suffix (238 is the most a list-form item may carry).
    const keyed = (length: number) => ({ channel: 'CHANNEL_SMS', recipients: ['+14155550133'], body: 'hi', idempotencyKey: `${randomUUID()}`.padEnd(length, 'k') });
    expect(await errorOf([keyed(239)])).toContain('at most 238 characters');
    expect((await bulk([keyed(238)])).notifications[0].idempotencyKey).toHaveLength(255);
    // A bad target is reported against the client's item, not the expanded position.
    expect(await errorOf([ok, { channel: 'CHANNEL_SMS', recipients: ['+14155550134', 'not-a-number'], body: 'hi' }])).toContain('notifications.1[1].recipient');
  });

  it('does not re-send to a recipient when a retry adds recipients under the same key', async () => {
    const idempotencyKey = `k-${randomUUID()}`;
    const bulk = (recipients: string[]) =>
      hub.call('NotificationService', 'SendBulkNotifications', { notifications: [{ channel: 'CHANNEL_SMS', recipients, body: 'hi', idempotencyKey }] }, hub.tenant(key));
    const first = await bulk(['+14155550120']);
    const second = await bulk(['+14155550120', '+14155550121']);
    expect(second).toMatchObject({ accepted: 2, replayed: 1 });
    expect(second.notifications[0].id).toBe(first.notifications[0].id);
  });

  it('pushes to every registered device of a user', async () => {
    await hub.call('DeviceService', 'RegisterDevice', { userId: 'u-1', token: `tok-${randomUUID()}`, platform: 'DEVICE_PLATFORM_ANDROID' }, hub.tenant(key));
    const res = await send({ channel: 'CHANNEL_PUSH', userId: 'u-1', subject: 'Hi', template: 'welcome', data: struct({ name: 'Jane' }) });
    expect((await hub.waitForFinal(key, res.notification.id)).notification.status).toBe('NOTIFICATION_STATUS_SENT');
  });

  it('fails permanently without retries when a user has no devices, and can be retried', async () => {
    const res = await send({ channel: 'CHANNEL_PUSH', userId: 'nobody', body: 'hi' });
    const failed = await hub.waitForFinal(key, res.notification.id);
    expect(failed.notification).toMatchObject({ status: 'NOTIFICATION_STATUS_FAILED', attempts: 1 });
    expect(failed.attempts[0].permanent).toBe(true);

    await hub.call('DeviceService', 'RegisterDevice', { userId: 'nobody', token: `tok-${randomUUID()}`, platform: 'DEVICE_PLATFORM_IOS' }, hub.tenant(key));
    const retried = await hub.call('NotificationService', 'RetryNotification', { id: res.notification.id }, hub.tenant(key));
    expect(retried.status).toBe('NOTIFICATION_STATUS_QUEUED');
    expect((await hub.waitForFinal(key, res.notification.id)).notification.status).toBe('NOTIFICATION_STATUS_SENT');
  });

  it('cancels a scheduled notification', async () => {
    const res = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'later', scheduledAt: timestamp(new Date(Date.now() + 3_600_000)) });
    const cancelled = await hub.call('NotificationService', 'CancelNotification', { id: res.notification.id }, hub.tenant(key));
    expect(cancelled.status).toBe('NOTIFICATION_STATUS_CANCELLED');
    await hub.expectError(
      hub.call('NotificationService', 'CancelNotification', { id: res.notification.id }, hub.tenant(key)),
      status.FAILED_PRECONDITION,
      'NOTIFICATION_NOT_CANCELLABLE',
    );
  });

  it('paginates with a cursor', async () => {
    const first = await hub.call('NotificationService', 'ListNotifications', { page: { limit: 2 } }, hub.tenant(key));
    expect(first.notifications).toHaveLength(2);
    const second = await hub.call('NotificationService', 'ListNotifications', { page: { limit: 2, cursor: first.page.nextCursor } }, hub.tenant(key));
    const ids = (page: Msg): string[] => page.notifications.map((n: Msg) => n.id);
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
  });

  it('isolates tenants and revokes keys immediately', async () => {
    const created = await hub.call('TenantAdminService', 'CreateTenant', { name: 'Other', slug: `e2e-${randomUUID().slice(0, 8)}` }, hub.admin());
    const otherKey = created.apiKey.key as string;
    const mine = await hub.call('NotificationService', 'ListNotifications', { page: { limit: 1 } }, hub.tenant(key));
    await hub.expectError(
      hub.call('NotificationService', 'GetNotification', { id: mine.notifications[0].id }, hub.tenant(otherKey)),
      status.NOT_FOUND,
      'NOTIFICATION_NOT_FOUND',
    );

    await hub.call('TenantAdminService', 'RevokeApiKey', { tenantId: created.tenant.id, keyId: created.apiKey.apiKey.id }, hub.admin());
    await hub.expectError(hub.call('NotificationService', 'ListNotifications', {}, hub.tenant(otherKey)), status.UNAUTHENTICATED, 'API_KEY_INVALID');
  });
});
