/**
 * Unit tests for the worker-side delivery logic: status transitions,
 * permanent vs. transient error handling and push fan-out. Collaborators
 * are fakes; the real TemplateService renders src/views.
 */

import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { NotificationChannel, NotificationStatus } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { EmailService } from '../../utils/email/email.service.js';
import { PushService } from '../../utils/firebase/push.service.js';
import { SmsService } from '../../utils/sms/sms.service.js';
import { TemplateService } from '../../utils/template/template.service.js';
import { DeviceRepository } from '../device/device.repository.js';
import { NotificationAttemptRepository } from './notification-attempt.repository.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationRepository } from './notification.repository.js';

/** A fake channel service whose send() succeeds. */
const channelService = (name: string) => ({
  providerName: name,
  send: vi.fn().mockResolvedValue({ provider: name, providerMessageId: `${name}-1` }),
});

/** Builds a dispatcher around fakes and the given notification row. */
function setup(notification: Partial<Notification>) {
  const row = {
    id: 'n-1',
    tenantId: 't-1',
    tenant: { settings: {} },
    recipient: null,
    userId: null,
    subject: null,
    body: null,
    template: null,
    data: null,
    metadata: null,
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
  const email = channelService('ses');
  const sms = channelService('twilio');
  const push = channelService('fcm');
  const config = {
    getOrThrow: () => ({ name: 'Hub', mail: { from: 'Hub <no-reply@hub.io>' } }),
  } as unknown as ConfigService;

  const dispatcher = new NotificationDispatcher(
    notifications as unknown as NotificationRepository,
    attempts as unknown as NotificationAttemptRepository,
    devices as unknown as DeviceRepository,
    new TemplateService(),
    email as unknown as EmailService,
    sms as unknown as SmsService,
    push as unknown as PushService,
    config,
  );
  return { dispatcher, notifications, attempts, devices, email, sms, push };
}

/** A minimal BullMQ job: attempts made so far and the attempt limit. */
const job = (attemptsMade = 0, attempts = 3) =>
  ({ data: { notificationId: 'n-1' }, attemptsMade, opts: { attempts } }) as unknown as Job;

describe('NotificationDispatcher', () => {
  it('renders the email template with tenant branding and marks it sent', async () => {
    const t = setup({
      channel: NotificationChannel.Email,
      recipient: 'jane@example.com',
      subject: 'Code {{code}}',
      template: 'otp',
      data: { name: '<Jane>', code: '123456' },
      tenant: { settings: { appName: 'Acme', emailFrom: 'Acme <hi@acme.io>' } } as Notification['tenant'],
    });
    await t.dispatcher.dispatch(job());

    const message = t.email.send.mock.calls[0][0];
    expect(message).toMatchObject({ to: 'jane@example.com', from: 'Acme <hi@acme.io>', subject: 'Code 123456' });
    expect(message.html).toContain('Acme');
    // {{values}} are HTML-escaped in email templates.
    expect(message.html).toContain('&lt;Jane&gt;');
    expect(t.notifications.markSent).toHaveBeenCalledWith('n-1', 'ses', 'ses-1');
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: true, attempt: 1 }));
  });

  it('skips notifications that are no longer deliverable (sent/cancelled)', async () => {
    const t = setup({ channel: NotificationChannel.Sms });
    t.notifications.markProcessing.mockResolvedValue(null);
    await t.dispatcher.dispatch(job());
    expect(t.sms.send).not.toHaveBeenCalled();
  });

  it('marks transient errors as retrying and rethrows so BullMQ retries', async () => {
    const t = setup({ channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' });
    t.sms.send.mockRejectedValue(new Error('ECONNRESET'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toThrow('ECONNRESET');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Retrying, 'twilio', 'ECONNRESET');
  });

  it('marks the last transient failure as failed', async () => {
    const t = setup({ channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' });
    t.sms.send.mockRejectedValue(new Error('timeout'));
    await expect(t.dispatcher.dispatch(job(2, 3))).rejects.toThrow('timeout');
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'timeout');
  });

  it('fails permanent errors immediately with UnrecoverableError', async () => {
    const t = setup({ channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' });
    t.sms.send.mockRejectedValue(new PermanentDeliveryError('unsubscribed', 'twilio'));
    await expect(t.dispatcher.dispatch(job(0, 3))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.notifications.markFailure).toHaveBeenCalledWith('n-1', NotificationStatus.Failed, 'twilio', 'unsubscribed');
    expect(t.attempts.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, permanent: true }));
  });

  it('fans push out to the user devices and deactivates dead tokens', async () => {
    const t = setup({ channel: NotificationChannel.Push, userId: 'u-1', body: 'hi', metadata: { deeplink: 'app://x' } });
    t.devices.activeTokens.mockResolvedValue(['a', 'b']);
    t.push.send.mockResolvedValue({ provider: 'fcm', providerMessageId: 'm', invalidTokens: ['b'] });
    await t.dispatcher.dispatch(job());

    expect(t.push.send.mock.calls[0][0]).toMatchObject({
      tokens: ['a', 'b'],
      data: { deeplink: 'app://x', notificationId: 'n-1' },
    });
    expect(t.devices.deactivate).toHaveBeenCalledWith('t-1', ['b']);
  });

  it('fails push-to-user permanently when the user has no devices', async () => {
    const t = setup({ channel: NotificationChannel.Push, userId: 'u-1', body: 'hi' });
    await expect(t.dispatcher.dispatch(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.push.send).not.toHaveBeenCalled();
  });

  it('does not report a delivery failure when bookkeeping fails after sending', async () => {
    const t = setup({ channel: NotificationChannel.Sms, recipient: '+14155550123', body: 'hi' });
    t.notifications.markSent.mockRejectedValue(new Error('db down'));
    await expect(t.dispatcher.dispatch(job())).rejects.toThrow('db down');
    expect(t.notifications.markFailure).not.toHaveBeenCalled();
  });
});
