/**
 * Channel-dependent validation rules of SendNotificationDto.
 */

// class-transformer / class-validator decorators need the metadata polyfill.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SendNotificationDto } from './notification.dto.js';

/** All validation messages for a request body. */
const errorsFor = (body: Record<string, unknown>) =>
  validateSync(plainToInstance(SendNotificationDto, body)).flatMap((e) => Object.values(e.constraints ?? {}));

describe('SendNotificationDto', () => {
  it.each([
    [{ channel: 'email', recipient: 'jane@example.com', subject: 's', body: 'b' }],
    [{ channel: 'email', recipient: 'jane@example.com', subject: 's', template: 'welcome' }],
    // Templates carry their own subject.
    [{ channel: 'email', recipient: 'jane@example.com', template: 'welcome', templateVersion: 2 }],
    [{ channel: 'sms', recipient: '+14155550123', template: 'otp', senderId: '7d3f4b6e-2f7a-4c43-9d1e-2a9a3c1b5e10' }],
    [{ channel: 'sms', recipient: '+14155550123', body: 'b' }],
    [{ channel: 'push', recipient: 'device-token', body: 'b' }],
    [{ channel: 'push', userId: 'u-1', body: 'b' }],
    [{ channel: 'in_app', userId: 'u-1', body: 'b', alsoPush: true }],
    [{ channel: 'in_app', userId: 'u-1', template: 'welcome' }],
  ])('accepts %j', (body) => {
    expect(errorsFor(body)).toEqual([]);
  });

  it.each([
    [{ channel: 'email', recipient: 'not-an-email', subject: 's', body: 'b' }, 'valid email'],
    [{ channel: 'email', recipient: 'a@b.com', body: 'b' }, 'subject'],
    [{ channel: 'sms', recipient: '4155550123', body: 'b' }, 'E.164'],
    [{ channel: 'sms', recipient: '+14155550123' }, 'body'],
    [{ channel: 'push', body: 'b' }, 'recipient'],
    [{ channel: 'push', userId: 'u-1', recipient: 'tok', body: 'b' }, 'userId'],
    [{ channel: 'email', userId: 'u-1', recipient: 'a@b.com', subject: 's', body: 'b' }, 'userId'],
    [{ channel: 'in_app', body: 'b' }, 'userId is required'],
    [{ channel: 'in_app', userId: 'u-1', recipient: 'x', body: 'b' }, 'not used for CHANNEL_IN_APP'],
    [{ channel: 'email', recipient: 'a@b.com', subject: 's', template: '../etc/passwd' }, 'template'],
    [{ channel: 'email', recipient: 'a@b.com', template: 'otp', templateVersion: 0 }, 'templateVersion'],
    [{ channel: 'sms', recipient: '+14155550123', body: 'b', senderId: 'not-a-uuid' }, 'senderId'],
    [{ channel: undefined, recipient: 'a@b.com', body: 'b' }, 'CHANNEL_EMAIL'],
  ])('rejects %j', (body, expected) => {
    expect(errorsFor(body).join(' ')).toContain(expected);
  });
});
