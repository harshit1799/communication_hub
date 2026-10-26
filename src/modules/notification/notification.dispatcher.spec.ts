/**
 * Unit tests for the worker-side delivery logic: status transitions,
 * permanent vs. transient errors, provider failover, sender use, pinned
 * template versions and push fan-out. Storage and vendors are fakes; the
 * real TemplateService/TemplateRenderer render the content.
 */

import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { NotificationChannel, NotificationStatus, ProviderKind } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { TemplateRenderer } from '../../utils/template/template-renderer.js';
import { DeviceRepository } from '../device/device.repository.js';
import { InboxService } from '../inbox/inbox.service.js';
import { ProviderResolver } from '../provider/provider.resolver.js';
import type { ProviderHandle } from '../provider/provider.types.js';
import { SenderResolver } from '../sender/sender.resolver.js';
import { TemplateRepository } from '../template/template.repository.js';
import { TemplateService } from '../template/template.service.js';
import { NotificationAttemptRepository } from './notification-attempt.repository.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationRepository } from './notification.repository.js';

/** A fake provider client whose send() succeeds. */
const client = (name: string) => ({
  name,
  describe: () => name,
  send: vi.fn().mockResolvedValue({ provider: name, providerMessageId: `${name}-1` }),
});
type FakeClient = ReturnType<typeof client>;

/** A provider handle around a fake client (provider kind = client name). */
const handle = (c: FakeClient, id = `cfg-${c.name}`): ProviderHandle =>
  ({ spec: { id, provider: c.name as ProviderKind }, client: () => Promise.resolve(c) }) as unknown as ProviderHandle;

/** Builds a dispatcher around fakes and the given notification row. */
function setup(notification: Partial<Notification>, options: { providers?: FakeClient[]; version?: object } = {}) {
  const row = {
    id: 'n-1',
    tenantId: 't-1',
    tenant: { settings: { appName: 'Acme' } },
    recipient: null,
    userId: null,
    subject: null,
    body: null,
    template: null,
    templateId: null,
    templateVersion: null,
    data: null,
    metadata: null,
    senderId: null,
    ...notification,
  } as Notification;
  const notifications = {
    markProcessing: vi.fn().mockResolvedValue(1),
    findWithTenant: vi.fn().mockResolvedValue(row),
    markSent: vi.fn(),
    markFailure: vi.fn(),
  };
  const attempts = { record: vi.fn() };
  const devices = { activeTokens: vi.fn().mockResolvedValue([]), deactivate: vi.fn() };
  const clients = options.providers ?? [client('ses')];
  const providers = {
    resolve: vi.fn().mockResolvedValue(clients.map((c) => handle(c))),
    platformName: () => 'console',
  };
  const senders = { resolve: vi.fn().mockResolvedValue(null) };
  const config = {
    getOrThrow: () => ({ name: 'Hub', mail: { from: 'Hub <no-reply@hub.io>' }, cache: { templateTtlSeconds: 60 } }),
  } as unknown as ConfigService;
  const templateRepo = {
    findVersion: vi.fn().mockResolvedValue(options.version ? { id: 'v-1', ...options.version } : null),
  };
  const redis = { cached: (_key: string, _ttl: number, load: () => Promise<unknown>) => load() };
  const templates = new TemplateService(
    templateRepo as unknown as TemplateRepository,
    new TemplateRenderer(),
    redis as unknown as RedisService,
    config,
  );
  const metrics = new MetricsService();
  const inbox = {
    deliver: vi.fn().mockResolvedValue({ id: 'inbox-1' }),
    unreadCount: vi.fn().mockResolvedValue(3),
  };

  const dispatcher = new NotificationDispatcher(
    notifications as unknown as NotificationRepository,
    attempts as unknown as NotificationAttemptRepository,
    devices as unknown as DeviceRepository,
    templates,
    senders as unknown as SenderResolver,
    providers as unknown as ProviderResolver,
    metrics,
    inbox as unknown as InboxService,
    config,
  );
  return { dispatcher, notifications, attempts, devices, providers, senders, templateRepo, clients, metrics, inbox };
}

/** A minimal BullMQ job: attempts made so far and the attempt limit. */
const job = (attemptsMade = 0, attempts = 3) =>
  ({ id: 'j-1', data: { notificationId: 'n-1', requestId: 'req-1' }, attemptsMade, opts: { attempts } }) as unknown as Job;

const sms = { channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' };

describe('NotificationDispatcher', () => {
  it('renders the pinned email version with tenant branding, uses the resolved sender, and marks it sent', async () => {
    const t = setup(
      {
        channel: NotificationChannel.Email,
        recipient: 'jane@example.com',
        template: 'otp',
        templateId: 'tpl-1',
        templateVersion: 3,
        data: { name: '<Jane>', code: '123456' },
      },
      { version: { subject: 'Code {{code}}', html: '<p>{{appName}}: hi {{name}}</p>', body: null } },
    );
    t.senders.resolve.mockResolvedValue({ senderId: 's-1', value: 'Acme <hi@acme.io>', providerConfigId: 'cfg-ses', source: 'rule' });
    await t.dispatcher.dispatch(job());

    expect(t.templateRepo.findVersion).toHaveBeenCalledWith('tpl-1', 3);
    expect(t.providers.resolve).toHaveBeenCalledWith('t-1', NotificationChannel.Email, 'cfg-ses');
    const message = t.clients[0].send.mock.calls[0][0];
    expect(message).toMatchObject({ to: 'jane@example.com', from: 'Acme <hi@acme.io>', subject: 'Code 123456' });
    // {{values}} are HTML-escaped in the HTML part.
    expect(message.html).toBe('<p>Acme: hi &lt;Jane&gt;</p>');
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'ses', 'ses-1');
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: true, attempt: 1, sender: 'Acme <hi@acme.io>' }));
  });

  it('an inline subject overrides the template subject; no sender falls back to MAIL_FROM', async () => {
    const t = setup(
      { channel: NotificationChannel.Email, recipient: 'a@b.com', subject: 'Custom {{x}}', templateId: 'tpl-1', templateVersion: 1, template: 'w', data: { x: '!' } },
      { version: { subject: 'Template subject', html: '<title>{{subject}}</title>' } },
    );
    await t.dispatcher.dispatch(job());
    expect(t.clients[0].send.mock.calls[0][0]).toMatchObject({ from: 'Hub <no-reply@hub.io>', subject: 'Custom !', html: '<title>Custom !</title>' });
  });

  it('skips notifications that are no longer deliverable (sent/cancelled)', async () => {
    const t = setup(sms);
    t.notifications.markProcessing.mockResolvedValue(null);
    await t.dispatcher.dispatch(job());
    expect(t.clients[0].send).not.toHaveBeenCalled();
  });

  it('marks transient errors as retrying and rethrows so BullMQ retries', async () => {
    const t = setup(sms, { providers: [client('twilio')] });
    t.clients[0].send.mockRejectedValue(new Error('ECONNRESET'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toThrow('ECONNRESET');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'twilio', 'ECONNRESET');
  });

  it('marks the last transient failure as failed', async () => {
    const t = setup(sms, { providers: [client('twilio')] });
    t.clients[0].send.mockRejectedValue(new Error('timeout'));
    await expect(t.dispatcher.dispatch(job(2, 3))).rejects.toThrow('timeout');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'timeout');
  });

  it('fails permanent errors immediately with UnrecoverableError, without failing over', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.clients[0].send.mockRejectedValue(new PermanentDeliveryError('unsubscribed', 'twilio'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.clients[1].send).not.toHaveBeenCalled();
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'unsubscribed');
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, permanent: true }));
  });

  it('fails over to the next provider on a transient error, within the same attempt', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.clients[0].send.mockRejectedValue(new Error('503 from Twilio'));
    await t.dispatcher.dispatch(job());

    expect(t.clients[1].send).toHaveBeenCalledTimes(1);
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'sns', 'sns-1');
    expect(t.notifications.markFailure).not.toHaveBeenCalled();
    expect(t.attempts.record.mock.calls.map(([a]) => [a.attempt, a.provider, a.success])).toEqual([
      [1, 'twilio', false],
      [1, 'sns', true],
    ]);
    const failovers = await t.metrics.failovers.get();
    expect(failovers.values).toEqual([expect.objectContaining({ value: 1, labels: { channel: 'sms', from_provider: 'twilio' } })]);
  });

  it('retries the job when every provider fails transiently', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.clients[0].send.mockRejectedValue(new Error('a down'));
    t.clients[1].send.mockRejectedValue(new Error('b down'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toThrow('b down');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'sns', 'b down');
    expect(t.attempts.record).toHaveBeenCalledTimes(2);
  });

  it('a provider whose client cannot be created fails over like a transient error', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.providers.resolve.mockResolvedValue([
      { spec: { id: 'bad', provider: 'twilio' }, client: () => Promise.reject(new Error('invalid service account')) },
      handle(t.clients[1]),
    ]);
    await t.dispatcher.dispatch(job());
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'sns', 'sns-1');
  });

  it('fails permanently when the requested sender is no longer active', async () => {
    const t = setup({ ...sms, senderId: 's-gone' });
    t.senders.resolve.mockRejectedValue(new PermanentDeliveryError('Sender s-gone is no longer active', 'sender'));
    await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'sender', 'Sender s-gone is no longer active');
    expect(t.clients[0].send).not.toHaveBeenCalled();
  });

  it('fails permanently when the pinned template version is gone', async () => {
    const t = setup({ ...sms, body: null, template: 'otp', templateId: 'tpl-1', templateVersion: 9 });
    await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'template', 'Template version 9 no longer exists');
  });

  it('fans push out to the user devices and deactivates dead tokens', async () => {
    const t = setup(
      { channel: NotificationChannel.Push, userId: 'u-1', body: 'hi', metadata: { deeplink: 'app://x' } },
      { providers: [client('fcm')] },
    );
    t.devices.activeTokens.mockResolvedValue(['a', 'b']);
    t.clients[0].send.mockResolvedValue({ provider: 'fcm', providerMessageId: 'm', invalidTokens: ['b'] });
    await t.dispatcher.dispatch(job());

    expect(t.clients[0].send.mock.calls[0][0]).toMatchObject({ tokens: ['a', 'b'], data: { deeplink: 'app://x', notificationId: 'n-1' } });
    expect(t.devices.deactivate).toHaveBeenCalledWith('t-1', ['b']);
  });

  it('fails push-to-user permanently when the user has no devices', async () => {
    const t = setup({ channel: NotificationChannel.Push, userId: 'u-1', body: 'hi' }, { providers: [client('fcm')] });
    await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.clients[0].send).not.toHaveBeenCalled();
  });

  it('does not report a delivery failure when bookkeeping fails after sending', async () => {
    const t = setup(sms);
    t.notifications.markSent.mockRejectedValue(new Error('db down'));
    await expect(t.dispatcher.dispatch(job())).rejects.toThrow('db down');
    expect(t.notifications.markFailure).not.toHaveBeenCalled();
  });

  describe('in-app', () => {
    const inApp = { channel: NotificationChannel.InApp, userId: 'u-1', subject: 'Hi {{name}}', body: 'Order {{id}} shipped', data: { name: 'Jo', id: '42' }, metadata: { deeplink: 'app://orders/42' } };

    it('stores the inbox message, marks it sent and sends a silent FCM signal', async () => {
      const t = setup(inApp, { providers: [client('fcm')] });
      t.devices.activeTokens.mockResolvedValue(['tok-1']);
      await t.dispatcher.dispatch(job());

      expect(t.inbox.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'n-1' }), { title: 'Hi Jo', body: 'Order 42 shipped' });
      expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'inbox', 'inbox-1');
      expect(t.clients[0].send.mock.calls[0][0]).toMatchObject({
        tokens: ['tok-1'],
        silent: true,
        data: { type: 'inbox', inboxMessageId: 'inbox-1', notificationId: 'n-1', unreadCount: '3', deeplink: 'app://orders/42' },
      });
      expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ provider: 'inbox', success: true }));
    });

    it('alsoPush sends a visible push', async () => {
      const t = setup({ ...inApp, alsoPush: true }, { providers: [client('fcm')] });
      t.devices.activeTokens.mockResolvedValue(['tok-1']);
      await t.dispatcher.dispatch(job());
      expect(t.clients[0].send.mock.calls[0][0]).toMatchObject({ silent: false, title: 'Hi Jo', body: 'Order 42 shipped' });
    });

    it('a failed signal does not fail the delivery; signals fail over across push providers', async () => {
      const t = setup(inApp, { providers: [client('fcm'), client('console')] });
      t.devices.activeTokens.mockResolvedValue(['tok-1']);
      t.clients[0].send.mockRejectedValue(new Error('FCM 503'));
      await t.dispatcher.dispatch(job());
      expect(t.clients[1].send).toHaveBeenCalledTimes(1);

      const allFail = setup(inApp, { providers: [client('fcm')] });
      allFail.devices.activeTokens.mockResolvedValue(['tok-1']);
      allFail.clients[0].send.mockRejectedValue(new Error('FCM down'));
      await expect(allFail.dispatcher.dispatch(job())).resolves.toBeUndefined();
      expect(allFail.notifications.markSent).toHaveBeenCalled();
      expect(allFail.notifications.markFailure).not.toHaveBeenCalled();
    });

    it('skips the signal without devices, and retries when the inbox write fails', async () => {
      const t = setup(inApp, { providers: [client('fcm')] });
      await t.dispatcher.dispatch(job());
      expect(t.clients[0].send).not.toHaveBeenCalled();

      const broken = setup(inApp, { providers: [client('fcm')] });
      broken.inbox.deliver.mockRejectedValue(new Error('db timeout'));
      await expect(broken.dispatcher.dispatch(job(0, 3))).rejects.toThrow('db timeout');
      expect(broken.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'inbox', 'db timeout');
    });
  });
});
