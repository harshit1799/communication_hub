/**
 * Validated inputs of NotificationService (proto/communication_hub/v1/notification.proto).
 * Controllers decode the proto message (enums, Timestamp, Struct) into
 * these shapes and validate them with validateInput().
 *
 *   email: { channel: email, recipient, subject | template, body | template }
 *   sms:   { channel: sms,   recipient: "+14155550123", body | template }
 *   push:  { channel: push,  recipient: <token> | userId, subject?, body | template }
 *   in-app: { channel: in_app, userId, subject?, body | template, alsoPush? }
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CursorPaginationDto } from '../common/dtos/common.dtos.js';
import {
  LIMITS,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  TEMPLATE_NAME_REGEX,
} from '../constant/index.js';
import { IsFromForChannel } from '../validator/from.validator.js';
import { IsPushUserTarget, IsRecipientForChannel } from '../validator/notification.validator.js';

/** Fields read by the conditional validators below. */
type SendInput = Pick<SendNotificationDto, 'channel' | 'userId' | 'template' | 'body' | 'subject' | 'recipient'>;

/** One notification to send (also each item of a bulk send). */
export class SendNotificationDto {
  @IsEnum(NotificationChannel, { message: 'channel must be CHANNEL_EMAIL, CHANNEL_SMS, CHANNEL_PUSH or CHANNEL_IN_APP' })
  channel: NotificationChannel;

  // Required unless a push targets a userId; in-app never has one.
  @ValidateIf((o: SendInput) =>
    o.channel === NotificationChannel.InApp ? o.recipient !== undefined : o.channel !== NotificationChannel.Push || !o.userId,
  )
  @IsNotEmpty({ message: 'recipient should not be empty' })
  @MaxLength(500)
  @IsRecipientForChannel()
  recipient?: string;

  // Required for in-app (the inbox owner).
  @ValidateIf((o: SendInput) => o.channel === NotificationChannel.InApp || o.userId !== undefined)
  @IsString({ message: 'userId is required for CHANNEL_IN_APP' })
  @IsNotEmpty()
  @MaxLength(128)
  @IsPushUserTarget()
  userId?: string;

  // Required for email without a template (templates carry their own subject).
  @ValidateIf((o: SendInput) => (o.channel === NotificationChannel.Email && !o.template) || o.subject !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject?: string;

  @ValidateIf((o: SendInput) => !o.template || o.body !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  body?: string;

  @IsOptional()
  @Matches(TEMPLATE_NAME_REGEX, { message: 'template may only contain lowercase letters, digits and dashes' })
  @MaxLength(100)
  template?: string;

  // Pin a template version (default: the active one).
  @IsOptional()
  @IsInt()
  @Min(1)
  templateVersion?: number;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @IsOptional()
  @IsDate()
  scheduledAt?: Date;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(LIMITS.IDEMPOTENCY_KEY_MAX)
  idempotencyKey?: string;

  // Email / SMS: overrides the provider's settings.from.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsFromForChannel()
  from?: string;

  // In-app only: also show a visible push (checked in NotificationService).
  @IsOptional()
  @IsBoolean()
  alsoPush?: boolean;
}

/** SendBulkNotifications. */
export class SendBulkNotificationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LIMITS.BULK_MAX)
  @ValidateNested({ each: true })
  @Type(() => SendNotificationDto)
  notifications: SendNotificationDto[];
}

/** ListNotifications: pagination plus optional filters. */
export class ListNotificationsDto extends CursorPaginationDto {
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipient?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  userId?: string;
}

/** NotificationRef: bad ids give INVALID_ARGUMENT, not INTERNAL. */
export class NotificationIdDto {
  @IsUUID()
  id: string;
}
