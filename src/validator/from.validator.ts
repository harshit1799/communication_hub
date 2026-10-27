/**
 * "From" format per channel (provider settings.from, NotificationInput.from):
 * an email address, optionally with a display name ("Acme <no-reply@acme.com>"),
 * or an SMS sender: an E.164 number, a short code, or an alphanumeric sender
 * id (3-11 characters).
 */

import { isEmail, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { E164_REGEX, NotificationChannel } from '../constant/index.js';

const DISPLAY_NAME_ADDRESS = /^[^<>]{0,200}<([^<>]+)>$/;
const SHORT_CODE = /^\d{3,8}$/;
const ALPHANUMERIC_ID = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{3,11}$/;

/** Whether `value` is a valid "From" for `channel`. */
export function isFromValue(channel: NotificationChannel | undefined, value: string): boolean {
  if (channel === NotificationChannel.Email) {
    const address = DISPLAY_NAME_ADDRESS.exec(value.trim())?.[1] ?? value.trim();
    return isEmail(address);
  }
  if (channel === NotificationChannel.Sms) {
    return E164_REGEX.test(value) || SHORT_CODE.test(value) || ALPHANUMERIC_ID.test(value);
  }
  return false;
}

/** From names ("billing"): see modules/provider/from-addresses.ts. */
const FROM_NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;

/**
 * A send's `from`: a From name ("billing") or an address valid for the
 * DTO's channel (email / SMS only). Whether the name exists is checked by
 * NotificationService against the tenant's providers.
 */
export function IsFromForChannel(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isFromForChannel',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const channel = (args.object as { channel?: NotificationChannel }).channel;
          if (channel !== NotificationChannel.Email && channel !== NotificationChannel.Sms) return false;
          return typeof value === 'string' && (FROM_NAME.test(value) || isFromValue(channel, value));
        },
        defaultMessage(args: ValidationArguments) {
          const channel = (args.object as { channel?: NotificationChannel }).channel;
          if (channel === NotificationChannel.Sms) return 'from must be a From name or an E.164 number, a short code or a 3-11 character alphanumeric sender id';
          if (channel === NotificationChannel.Email) return 'from must be a From name or an email address, optionally "Name <address>"';
          return 'from is only supported for CHANNEL_EMAIL and CHANNEL_SMS';
        },
      },
    });
}
