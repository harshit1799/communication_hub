/**
 * Request/response DTOs for /v1/notifications.
 * class-validator decorators validate input; @ApiProperty documents it.
 *
 *   email: { channel: "email", recipient, subject, body | template }
 *   sms:   { channel: "sms",   recipient: "+14155550123", body | template }
 *   push:  { channel: "push",  recipient: <token> | userId, subject?, body | template }
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CursorPageMetaDto, CursorPaginationDto } from '../common/dtos/common.dtos.js';
import {
  LIMITS,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  TEMPLATE_NAME_REGEX,
} from '../constant/index.js';
import { IsPushUserTarget, IsRecipientForChannel } from '../validator/notification.validator.js';

/** Fields read by the conditional validators below. */
type SendInput = Pick<SendNotificationDto, 'channel' | 'userId' | 'template' | 'body' | 'subject'>;

/**
 * Body of POST /v1/notifications (and each item of a bulk send).
 * The rules depend on `channel`; see the file header for the shapes.
 */
export class SendNotificationDto {
  @ApiProperty({ enum: NotificationChannel, example: NotificationChannel.Email })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @ApiPropertyOptional({
    description:
      'Email address (email), E.164 phone number (sms) or device token (push). ' +
      'For push, send `userId` instead to reach all of a user\'s devices.',
    example: 'jane@example.com',
  })
  // Required unless a push targets a userId.
  @ValidateIf((o: SendInput) => o.channel !== NotificationChannel.Push || !o.userId)
  @IsNotEmpty()
  @MaxLength(500)
  @IsRecipientForChannel()
  recipient?: string;

  @ApiPropertyOptional({
    description: 'Push only: your user id; delivers to every registered device of the user.',
    example: 'user-42',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @IsPushUserTarget()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Email subject (required for email) or push title. Supports {{placeholders}}.',
    example: 'Welcome to {{appName}}, {{name}}!',
  })
  @ValidateIf((o: SendInput) => o.channel === NotificationChannel.Email || o.subject !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject?: string;

  @ApiPropertyOptional({
    description: 'Plain-text content. Required when no template is given. Supports {{placeholders}}.',
    example: 'Thanks for signing up, {{name}}.',
  })
  @ValidateIf((o: SendInput) => !o.template || o.body !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  body?: string;

  @ApiPropertyOptional({
    description: 'Template file in src/views/<channel>/ (without extension), e.g. welcome, otp.',
    example: 'welcome',
  })
  @IsOptional()
  @Matches(TEMPLATE_NAME_REGEX, {
    message: 'template may only contain lowercase letters, digits and dashes',
  })
  @MaxLength(100)
  template?: string;

  @ApiPropertyOptional({
    description: 'Values for {{placeholders}} in the subject, body and template.',
    type: 'object',
    additionalProperties: true,
    example: { name: 'Jane', actionUrl: 'https://example.com/start' },
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Your own references (stored, returned on reads). For push also sent as the FCM data payload.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { orderId: 'ord_123', deeplink: 'app://orders/123' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  @ApiPropertyOptional({ enum: NotificationPriority, default: NotificationPriority.Normal })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({
    description: `Deliver at this time (ISO-8601, up to ${LIMITS.SCHEDULE_MAX_DAYS} days ahead). Omit to send now.`,
    example: '2026-12-01T09:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description:
      'Unique per tenant. Repeating a request with the same key returns the original ' +
      'notification instead of sending twice (safe client retries).',
    example: 'signup-welcome-user-42',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey?: string;
}

/** Body of POST /v1/notifications/bulk. */
export class SendBulkNotificationDto {
  @ApiProperty({ type: [SendNotificationDto], maxItems: LIMITS.BULK_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LIMITS.BULK_MAX)
  @ValidateNested({ each: true })
  @Type(() => SendNotificationDto)
  notifications: SendNotificationDto[];
}

/** Query of GET /v1/notifications: pagination plus optional filters. */
export class ListNotificationsDto extends CursorPaginationDto {
  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({ enum: NotificationChannel })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipient?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  userId?: string;
}

/** Route parameter `:id`, validated as a UUID (bad ids give 400, not 500). */
export class NotificationIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

/** One entry of a notification's delivery attempt log. */
export class NotificationAttemptResponseDto {
  @ApiProperty() attempt: number;
  @ApiProperty({ example: 'ses' }) provider: string;
  @ApiProperty() success: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) providerMessageId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) error: string | null;
  @ApiProperty({ description: 'True when the error stopped further retries' }) permanent: boolean;
  @ApiProperty() durationMs: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
}

/** A notification as returned by the API (tenant internals omitted). */
export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: NotificationChannel }) channel: NotificationChannel;
  @ApiPropertyOptional({ type: String, nullable: true }) recipient: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) userId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) subject: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) body: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) template: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  data: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  metadata: Record<string, string> | null;
  @ApiProperty({ enum: NotificationStatus }) status: NotificationStatus;
  @ApiProperty({ enum: NotificationPriority }) priority: NotificationPriority;
  @ApiPropertyOptional({ type: String, nullable: true }) idempotencyKey: string | null;
  @ApiProperty() attempts: number;
  @ApiPropertyOptional({ type: String, nullable: true }) provider: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) providerMessageId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) error: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) scheduledAt: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) sentAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}

/** GET /v1/notifications/:id: the notification plus its attempts. */
export class NotificationDetailsResponseDto extends NotificationResponseDto {
  @ApiProperty({ type: [NotificationAttemptResponseDto] })
  attemptLog: NotificationAttemptResponseDto[];
}

/** One page of GET /v1/notifications. */
export class NotificationListResponseDto extends CursorPageMetaDto {
  @ApiProperty({ type: [NotificationResponseDto] })
  data: NotificationResponseDto[];
}

/** Result of a bulk send. */
export class BulkNotificationResponseDto {
  @ApiProperty({ description: 'Number of notifications accepted' })
  accepted: number;

  @ApiProperty({ type: [NotificationResponseDto], description: 'In request order' })
  notifications: NotificationResponseDto[];
}
