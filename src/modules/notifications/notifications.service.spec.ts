/**
 * Unit tests for NotificationsService. Uses a fake email provider and a fake
 * repository so the service logic is tested without real delivery or a
 * database, and the real TemplatesService so src/views is exercised too.
 */

// Exception type thrown for bad template usage.
import { BadRequestException } from '@nestjs/common';
// Config service, faked below with just the app name.
import { ConfigService } from '@nestjs/config';
// Builds a small Nest DI container for tests.
import { Test } from '@nestjs/testing';
// DI token of the entity's repository.
import { getRepositoryToken } from '@nestjs/typeorm';
// Real template renderer.
import { TemplatesService } from '../templates/templates.service.js';
// Provider token and contract.
import {
  CHANNEL_PROVIDERS,
  ChannelProvider,
} from './channels/channel-provider.interface.js';
// Entity whose repository is faked.
import { Notification } from './entities/notification.entity.js';
// Enums used in test inputs/assertions.
import { NotificationChannel } from './enums/notification-channel.enum.js';
import { NotificationStatus } from './enums/notification-status.enum.js';
// The service under test.
import { NotificationsService } from './notifications.service.js';

describe('NotificationsService', () => {
  let service: NotificationsService;
  // Mock send function that succeeds with a fixed message id by default.
  const send = vi.fn().mockResolvedValue({ providerMessageId: 'msg-1' });
  // Fake provider that only handles the email channel.
  const emailProvider: ChannelProvider = {
    channel: NotificationChannel.Email,
    send,
  };
  // Fake repository: create() returns the input, save() assigns an id.
  const repository = {
    create: (input: Partial<Notification>) => ({ ...input }),
    save: vi.fn((n: Partial<Notification>) =>
      Promise.resolve({ ...n, id: n.id ?? 'id-1' }),
    ),
  };

  beforeEach(async () => {
    send.mockClear();
    repository.save.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        TemplatesService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => ({ name: 'Acme' }) },
        },
        { provide: getRepositoryToken(Notification), useValue: repository },
        // Inject only the fake email provider.
        { provide: CHANNEL_PROVIDERS, useValue: [emailProvider] },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  it('sends a plain message', async () => {
    const result = await service.send('acme', {
      channel: NotificationChannel.Email,
      recipient: 'a@b.com',
      subject: 'Hi',
      body: 'hello',
    });
    expect(result.status).toBe(NotificationStatus.Sent);
    expect(result.providerMessageId).toBe('msg-1');
    // Saved as pending first, then updated with the result.
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.save.mock.calls[0][0].status).toBe(
      NotificationStatus.Pending,
    );
    const message = send.mock.calls[0][0];
    expect(message).toMatchObject({ subject: 'Hi', text: 'hello' });
    expect(message.html).toBeUndefined();
  });

  it('renders an email template with config and data', async () => {
    const result = await service.send('acme', {
      channel: NotificationChannel.Email,
      recipient: 'a@b.com',
      subject: 'Welcome {{name}}',
      template: 'welcome',
      data: { name: '<Jane>' },
    });
    expect(result.subject).toBe('Welcome <Jane>');
    const { html } = send.mock.calls[0][0];
    // Brand name from config.
    expect(html).toContain('Acme');
    // Data is HTML-escaped inside templates.
    expect(html).toContain('Welcome, &lt;Jane&gt;!');
  });

  it('rejects unknown templates', async () => {
    await expect(
      service.send('acme', {
        channel: NotificationChannel.Email,
        recipient: 'a@b.com',
        subject: 'Hi',
        template: 'does-not-exist',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
    // Nothing is stored for invalid requests.
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('marks the send as failed when the provider throws', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    const result = await service.send('acme', {
      channel: NotificationChannel.Email,
      recipient: 'a@b.com',
      subject: 'Hi',
      body: 'hi',
    });
    expect(result.status).toBe(NotificationStatus.Failed);
    expect(result.error).toBe('boom');
  });

  it('rejects channels without a provider', async () => {
    // SMS has no provider in this test setup.
    await expect(
      service.send('acme', {
        channel: NotificationChannel.Sms,
        recipient: '+10000000000',
        body: 'hi',
      }),
    ).rejects.toThrow('No provider configured');
  });
});
