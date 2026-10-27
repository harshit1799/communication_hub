/**
 * Unit tests for the worker-side delivery logic: status transitions,
 * permanent vs. transient errors, provider failover, "From" selection, pinned
 * template versions and push fan-out. Storage and vendors are fakes; the
 * real TemplateService/TemplateRenderer render the content.
 */

import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { NotificationChannel, NotificationStatus, ProviderKind } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { TemplateRenderer } from '../../utils/template/template-renderer.js';
import { DeviceRepository } from '../device/device.repository.js';
import { InboxService } from '../inbox/inbox.service.js';
import { ProviderResolver } from '../provider/provider.resolver.js';
import { ProviderThrottle } from '../provider/provider-throttle.js';
import type { ProviderHandle } from '../provider/provider.types.js';
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
const handle = (c: FakeClient, settings: Record<string, string> = {}, id = `cfg-${c.name}`): ProviderHandle =>
  ({ spec: { id, provider: c.name as ProviderKind, settings }, client: () => Promise.resolve(c) }) as unknown as ProviderHandle;

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
    fromAddress: null,
    ...notification,
  } as Notification;
  const notifications = {
    markProcessing: vi.fn().mockResolvedValue(1),
    findWithTenant: vi.fn().mockResolvedValue(row),
    markSent: vi.fn(),
    markFailure: vi.fn(),
    releaseClaim: vi.fn(),
  };
  const attempts = { record: vi.fn() };
  const devices = { activeTokens: vi.fn().mockResolvedValue([]), deactivate: vi.fn() };
  const clients = options.providers ?? [client('ses')];
  const providers = {
    resolve: vi.fn().mockResolvedValue(clients.map((c) => handle(c))),
    platformName: () => 'console',
  };
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
  // Every provider has room unless a test says otherwise.
  const throttle = { acquire: vi.fn().mockResolvedValue({ ok: true, release: () => Promise.resolve() }) };
  const inbox = {
    deliver: vi.fn().mockResolvedValue({ id: 'inbox-1' }),
    unreadCount: vi.fn().mockResolvedValue(3),
  };

  const dispatcher = new NotificationDispatcher(
    notifications as unknown as NotificationRepository,
    attempts as unknown as NotificationAttemptRepository,
    devices as unknown as DeviceRepository,
    templates,
    providers as unknown as ProviderResolver,
    metrics,
    inbox as unknown as InboxService,
    throttle as unknown as ProviderThrottle,
    config,
  );
  return { dispatcher, notifications, attempts, devices, providers, templateRepo, clients, metrics, inbox, throttle };
}

/** A minimal BullMQ job: attempts made so far and the attempt limit. */
const job = (attemptsMade = 0, attempts = 3) =>
  ({ id: 'j-1', data: { notificationId: 'n-1', requestId: 'req-1' }, attemptsMade, opts: { attempts }, moveToDelayed: vi.fn() }) as unknown as Job & {
    moveToDelayed: ReturnType<typeof vi.fn>;
  };

const sms = { channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' };

describe('NotificationDispatcher', () => {
  it('renders the pinned email version with tenant branding, sends from the provider settings.from, and marks it sent', async () => {
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
    t.providers.resolve.mockResolvedValue([handle(t.clients[0], { from: 'Acme <hi@acme.io>' })]);
    await t.dispatcher.dispatch(job());

    expect(t.templateRepo.findVersion).toHaveBeenCalledWith('tpl-1', 3);
    expect(t.providers.resolve).toHaveBeenCalledWith('t-1', NotificationChannel.Email);
    const message = t.clients[0].send.mock.calls[0][0];
    expect(message).toMatchObject({ to: 'jane@example.com', from: 'Acme <hi@acme.io>', subject: 'Code 123456' });
    // {{values}} are HTML-escaped in the HTML part.
    expect(message.html).toBe('<p>Acme: hi &lt;Jane&gt;</p>');
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'ses', 'ses-1', expect.any(Object));
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: true, attempt: 1, sender: 'Acme <hi@acme.io>' }));
  });

  it('an inline subject overrides the template subject; no from falls back to MAIL_FROM', async () => {
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
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'twilio', 'ECONNRESET', null);
  });

  it('marks the last transient failure as failed', async () => {
    const t = setup(sms, { providers: [client('twilio')] });
    t.clients[0].send.mockRejectedValue(new Error('timeout'));
    await expect(t.dispatcher.dispatch(job(2, 3))).rejects.toThrow('timeout');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'timeout', null);
  });

  it('fails permanent errors immediately with UnrecoverableError, without failing over', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.clients[0].send.mockRejectedValue(new PermanentDeliveryError('unsubscribed', 'twilio'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.clients[1].send).not.toHaveBeenCalled();
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'unsubscribed', null);
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, permanent: true }));
  });

  it('fails over to the next provider on a transient error, within the same attempt', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.clients[0].send.mockRejectedValue(new Error('503 from Twilio'));
    await t.dispatcher.dispatch(job());

    expect(t.clients[1].send).toHaveBeenCalledTimes(1);
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'sns', 'sns-1', expect.any(Object));
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
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'sns', 'b down', null);
    expect(t.attempts.record).toHaveBeenCalledTimes(2);
  });

  it('a provider whose client cannot be created fails over like a transient error', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.providers.resolve.mockResolvedValue([
      { spec: { id: 'bad', provider: 'twilio', settings: {} }, client: () => Promise.reject(new Error('invalid service account')) },
      handle(t.clients[1]),
    ]);
    await t.dispatcher.dispatch(job());
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'sns', 'sns-1', expect.any(Object));
  });

  it('the request from overrides settings.from on every provider of a failover chain', async () => {
    const t = setup({ ...sms, fromAddress: 'ACMEIN' }, { providers: [client('twilio'), client('sns')] });
    t.providers.resolve.mockResolvedValue([handle(t.clients[0], { from: '+14155550100' }), handle(t.clients[1], { from: 'ACMEUS' })]);
    t.clients[0].send.mockRejectedValue(new Error('503'));
    await t.dispatcher.dispatch(job());
    expect(t.clients[0].send.mock.calls[0][0].from).toBe('ACMEIN');
    expect(t.clients[1].send.mock.calls[0][0].from).toBe('ACMEIN');
    expect(t.attempts.record.mock.calls.map(([a]) => a.sender)).toEqual(['ACMEIN', 'ACMEIN']);
  });

  it('each provider sends as its own settings.from; SMS without one leaves it to the vendor default', async () => {
    const t = setup(sms, { providers: [client('twilio'), client('sns')] });
    t.providers.resolve.mockResolvedValue([handle(t.clients[0], { from: '+14155550100' }), handle(t.clients[1])]);
    t.clients[0].send.mockRejectedValue(new Error('503'));
    await t.dispatcher.dispatch(job());
    expect(t.clients[0].send.mock.calls[0][0].from).toBe('+14155550100');
    expect(t.clients[1].send.mock.calls[0][0].from).toBeUndefined();
  });

  it('fails permanently when the pinned template version is gone', async () => {
    const t = setup({ ...sms, body: null, template: 'otp', templateId: 'tpl-1', templateVersion: 9 });
    await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'template', 'Template version 9 no longer exists', null);
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

  describe('provider limits', () => {
    const limited = (retryAfterMs: number, reason = 'rate') => ({ ok: false, reason, retryAfterMs });

    it('a provider at its limit is skipped for the next one', async () => {
      const t = setup(sms, { providers: [client('twilio'), client('sns')] });
      t.throttle.acquire.mockResolvedValueOnce(limited(800));
      await t.dispatcher.dispatch(job());
      expect(t.clients[0].send).not.toHaveBeenCalled();
      expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'sns', 'sns-1', expect.any(Object));
    });

    it('all providers at their limit: the job waits, without using an attempt', async () => {
      const t = setup(sms, { providers: [client('twilio'), client('sns')] });
      t.throttle.acquire.mockResolvedValueOnce(limited(800)).mockResolvedValueOnce(limited(300, 'concurrency'));
      const j = job();
      const before = Date.now();
      await expect(t.dispatcher.dispatch(j, 'token-1')).rejects.toBeInstanceOf(DelayedError);
      expect(t.notifications.releaseClaim).toHaveBeenCalledWith('n-1');
      const [runAt, token] = j.moveToDelayed.mock.calls[0];
      expect(token).toBe('token-1');
      expect(runAt).toBeGreaterThanOrEqual(before + 300);
      expect(runAt).toBeLessThan(before + 800);
      expect(t.notifications.markFailure).not.toHaveBeenCalled();
      expect(t.attempts.record).not.toHaveBeenCalled();
    });

    it('one provider failed and the rest are at their limit: wait rather than fail', async () => {
      const t = setup(sms, { providers: [client('twilio'), client('sns')] });
      t.clients[0].send.mockRejectedValue(new Error('503'));
      t.throttle.acquire.mockResolvedValueOnce({ ok: true, release: () => Promise.resolve() }).mockResolvedValueOnce(limited(500));
      await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(DelayedError);
      expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ provider: 'twilio', success: false }));
      expect(t.notifications.markFailure).not.toHaveBeenCalled();
    });

    it('releases the concurrency lease after the call, also on failure', async () => {
      const t = setup(sms, { providers: [client('twilio')] });
      const release = vi.fn().mockResolvedValue(undefined);
      t.throttle.acquire.mockResolvedValue({ ok: true, release });
      t.clients[0].send.mockRejectedValue(new Error('boom'));
      await expect(t.dispatcher.dispatch(job())).rejects.toThrow('boom');
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('in-app', () => {
    const inApp = { channel: NotificationChannel.InApp, userId: 'u-1', subject: 'Hi {{name}}', body: 'Order {{id}} shipped', data: { name: 'Jo', id: '42' }, metadata: { deeplink: 'app://orders/42' } };

    it('stores the inbox message, marks it sent and sends a silent FCM signal', async () => {
      const t = setup(inApp, { providers: [client('fcm')] });
      t.devices.activeTokens.mockResolvedValue(['tok-1']);
      await t.dispatcher.dispatch(job());

      expect(t.inbox.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'n-1' }), { title: 'Hi Jo', body: 'Order 42 shipped' });
      expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'inbox', 'inbox-1', expect.any(Object));
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
      expect(broken.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'inbox', 'db timeout', null);
    });
  });
});
