/**
 * Channel-aware validators for SendNotificationDto.
 */

import { isEmail, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { E164_REGEX, NotificationChannel } from '../constant/index.js';

/** The DTO fields these validators look at. */
interface ChannelTarget {
  channel?: NotificationChannel;
  recipient?: string;
  userId?: string;
}

/** Recipient format per channel. Push tokens are opaque, so they have no rule. */
const RECIPIENT_RULES: Partial<Record<NotificationChannel, { test: (v: string) => boolean; message: string }>> = {
  [NotificationChannel.Email]: {
    test: (v) => isEmail(v),
    message: 'recipient must be a valid email address',
  },
  [NotificationChannel.Sms]: {
    test: (v) => E164_REGEX.test(v),
    message: 'recipient must be an E.164 phone number, e.g. +14155550123',
  },
};

/** recipient must match the channel: email address, E.164 number or token. */
export function IsRecipientForChannel(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isRecipientForChannel',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const rule = RECIPIENT_RULES[(args.object as ChannelTarget).channel!];
          return typeof value === 'string' && (!rule || rule.test(value));
        },
        defaultMessage(args: ValidationArguments) {
          const rule = RECIPIENT_RULES[(args.object as ChannelTarget).channel!];
          return rule?.message ?? 'recipient must be a string';
        },
      },
    });
}

/** userId targets all of a user's devices: push only, and not with recipient. */
export function IsPushUserTarget(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPushUserTarget',
      target: object.constructor,
      propertyName,
      options: {
        message: 'userId is only supported for the push channel and cannot be combined with recipient',
        ...options,
      },
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const o = args.object as ChannelTarget;
          return o.channel === NotificationChannel.Push && !o.recipient;
        },
      },
    });
}
