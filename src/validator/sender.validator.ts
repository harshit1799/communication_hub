/**
 * Sender value format per channel: an email address, optionally with a
 * display name ("Acme <no-reply@acme.com>"), or an SMS sender: an E.164
 * number, a short code, or an alphanumeric sender id (3-11 characters).
 */

import { isEmail, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { E164_REGEX, NotificationChannel } from '../constant/index.js';

const DISPLAY_NAME_ADDRESS = /^[^<>]{0,200}<([^<>]+)>$/;
const SHORT_CODE = /^\d{3,8}$/;
const ALPHANUMERIC_ID = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{3,11}$/;

/** Whether `value` is a valid sender for `channel`. */
export function isSenderValue(channel: NotificationChannel | undefined, value: string): boolean {
  if (channel === NotificationChannel.Email) {
    const address = DISPLAY_NAME_ADDRESS.exec(value.trim())?.[1] ?? value.trim();
    return isEmail(address);
  }
  if (channel === NotificationChannel.Sms) {
    return E164_REGEX.test(value) || SHORT_CODE.test(value) || ALPHANUMERIC_ID.test(value);
  }
  return false;
}

export function IsSenderValueForChannel(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isSenderValueForChannel',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const channel = (args.object as { channel?: NotificationChannel }).channel;
          return typeof value === 'string' && isSenderValue(channel, value);
        },
        defaultMessage(args: ValidationArguments) {
          return (args.object as { channel?: NotificationChannel }).channel === NotificationChannel.Sms
            ? 'value must be an E.164 number, a short code or a 3-11 character alphanumeric sender id'
            : 'value must be an email address, optionally "Name <address>"';
        },
      },
    });
}
