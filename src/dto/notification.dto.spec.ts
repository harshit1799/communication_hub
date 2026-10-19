/**
 * Channel-dependent validation rules of SendNotificationDto.
 */

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
    [{ channel: 'sms', recipient: '+14155550123', body: 'b' }],
    [{ channel: 'push', recipient: 'device-token', body: 'b' }],
    [{ channel: 'push', userId: 'u-1', body: 'b' }],
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
    [{ channel: 'email', recipient: 'a@b.com', subject: 's', template: '../etc/passwd' }, 'template'],
  ])('rejects %j', (body, expected) => {
    expect(errorsFor(body).join(' ')).toContain(expected);
  });
});
