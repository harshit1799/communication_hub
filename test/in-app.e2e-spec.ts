/**
 * In-app notifications end to end: queued like every channel, stored in the
 * user's inbox exactly once, devices signalled through the push providers
 * (silent by default, visible with alsoPush), managed through InboxService,
 * purged after retention.
 */

import { status } from '@grpc/grpc-js';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { MAINTENANCE_JOB } from '../src/constant/index.js';
import { InboxService } from '../src/modules/inbox/inbox.service.js';
import { MaintenanceProcessor } from '../src/modules/notification/maintenance.processor.js';
import { MetricsService } from '../src/utils/metrics/metrics.service.js';
import { Hub, Msg, startHub, struct } from './support/grpc-hub.js';

describe('In-app notifications (e2e)', () => {
  let hub: Hub;
  let key: string;
  const userId = `user-${randomUUID().slice(0, 8)}`;

  const send = (notification: object) => hub.call('NotificationService', 'SendNotification', { notification }, hub.tenant(key));
  const inbox = (method: string, req: object) => hub.call('InboxService', method, req, hub.tenant(key));
  const signals = async (outcome: string) =>
    (await hub.moduleRef.get(MetricsService).inboxSignals.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;

  beforeAll(async () => {
    hub = await startHub();
    ({ key } = await hub.createTenant({ appName: 'Acme' }));
    await hub.call('DeviceService', 'RegisterDevice', { userId, token: `tok-${randomUUID()}`, platform: 'DEVICE_PLATFORM_IOS' }, hub.tenant(key));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('delivers to the inbox through its own queue and signals the devices silently', async () => {
    const silentBefore = await signals('silent');
    const res = await send({
      channel: 'CHANNEL_IN_APP',
      userId,
      template: 'welcome',
      data: struct({ name: 'Jo' }),
      metadata: { deeplink: 'app://home' },
    });
    expect(res.notification).toMatchObject({ status: 'NOTIFICATION_STATUS_QUEUED', alsoPush: false, templateVersion: 1 });

    const { notification, attempts } = await hub.waitForFinal(key, res.notification.id);
    expect(notification).toMatchObject({ status: 'NOTIFICATION_STATUS_SENT', provider: 'inbox' });
    expect(attempts.map((a: Msg) => a.provider)).toEqual(['inbox']);

    const list = await inbox('ListInboxMessages', { userId });
    expect(list.unreadCount).toBe(1);
    expect(list.messages[0]).toMatchObject({
      notificationId: res.notification.id,
      title: 'Welcome to Acme',
      body: 'Welcome to Acme, Jo! Your account is ready.',
      metadata: { deeplink: 'app://home' },
      read: false,
    });
    expect(list.messages[0].id).toBe(notification.providerMessageId);
    expect(await signals('silent')).toBe(silentBefore + 1);
  });

  it('alsoPush delivers to the inbox and as a visible push', async () => {
    const visibleBefore = await signals('visible');
    const res = await send({ channel: 'CHANNEL_IN_APP', userId, subject: 'Sale', body: '50% off today', alsoPush: true });
    expect((await hub.waitForFinal(key, res.notification.id)).notification.status).toBe('NOTIFICATION_STATUS_SENT');
    expect(await signals('visible')).toBe(visibleBefore + 1);
    expect((await inbox('GetUnreadCount', { userId })).unreadCount).toBe(2);
  });

  it('marks read, marks all read and deletes, returning the unread count', async () => {
    const { messages } = await inbox('ListInboxMessages', { userId, unreadOnly: true });
    expect(messages).toHaveLength(2);
    expect((await inbox('MarkInboxMessagesRead', { userId, ids: [messages[0].id] })).unreadCount).toBe(1);
    // Ids of other users are ignored.
    expect((await inbox('MarkInboxMessagesRead', { userId: 'someone-else', ids: [messages[1].id] })).unreadCount).toBe(0);
    expect((await inbox('GetUnreadCount', { userId })).unreadCount).toBe(1);
    expect((await inbox('MarkAllInboxMessagesRead', { userId })).unreadCount).toBe(0);

    const read = await inbox('ListInboxMessages', { userId });
    expect(read.messages.every((m: Msg) => m.read && m.readAt)).toBe(true);
    await inbox('DeleteInboxMessage', { userId, id: messages[0].id });
    await hub.expectError(inbox('DeleteInboxMessage', { userId, id: messages[0].id }), status.NOT_FOUND, 'INBOX_MESSAGE_NOT_FOUND');
  });

  it('stores one inbox row per notification, however often the job runs', async () => {
    const res = await send({ channel: 'CHANNEL_IN_APP', userId, body: 'once' });
    await hub.waitForFinal(key, res.notification.id);
    const [row] = await hub.moduleRef.get(DataSource).query('SELECT * FROM notifications WHERE id = $1', [res.notification.id]);
    const service = hub.moduleRef.get(InboxService);
    const again = await service.deliver({ ...row, tenantId: row.tenant_id, userId: row.user_id, id: row.id, metadata: {} }, { body: 'twice?' });
    const [{ count }] = await hub.moduleRef
      .get(DataSource)
      .query('SELECT count(*)::int AS count FROM inbox_messages WHERE notification_id = $1', [res.notification.id]);
    expect(count).toBe(1);
    expect(again.body).toBe('once');
  });

  it('validates in-app requests', async () => {
    await hub.expectError(send({ channel: 'CHANNEL_IN_APP', body: 'no user' }), status.INVALID_ARGUMENT, 'VALIDATION_ERROR');
    await hub.expectError(send({ channel: 'CHANNEL_IN_APP', userId, recipient: 'x@y.z', body: 'b' }), status.INVALID_ARGUMENT, 'VALIDATION_ERROR');
    await hub.expectError(send({ channel: 'CHANNEL_SMS', recipient: '+14155550123', body: 'b', alsoPush: true }), status.INVALID_ARGUMENT, 'VALIDATION_ERROR');
  });

  it('purges expired messages through the maintenance queue', async () => {
    const res = await send({ channel: 'CHANNEL_IN_APP', userId, body: 'old news' });
    const { notification } = await hub.waitForFinal(key, res.notification.id);
    const db = hub.moduleRef.get(DataSource);
    await db.query(`UPDATE inbox_messages SET expires_at = now() - interval '1 day' WHERE id = $1`, [notification.providerMessageId]);
    // Expired messages are hidden right away...
    const visible = await inbox('ListInboxMessages', { userId });
    expect(visible.messages.map((m: Msg) => m.id)).not.toContain(notification.providerMessageId);
    // ...and deleted by the purge job.
    const result = await hub.moduleRef.get(MaintenanceProcessor).process({ name: MAINTENANCE_JOB.PURGE_INBOX } as Job);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await db.query('SELECT 1 FROM inbox_messages WHERE id = $1', [notification.providerMessageId])).toHaveLength(0);
  });
});
