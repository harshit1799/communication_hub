/**
 * Request body for POST /api/v1/notifications.
 * class-validator decorators validate input; @ApiProperty documents it in Swagger.
 *
 * Two ways to send:
 *   - plain:     { channel, recipient, subject?, body }
 *   - template:  { channel: "email", recipient, subject, template, data }
 */

// Swagger decorators for required and optional properties.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// Validation rules applied by the global ValidationPipe.
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
// Allowed channel values.
import { NotificationChannel } from '../enums/notification-channel.enum.js';

export class SendNotificationDto {
  // Required: must be one of email | sms | push | webhook.
  @ApiProperty({
    enum: NotificationChannel,
    example: NotificationChannel.Email,
  })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  // Required non-empty string: where to deliver the message.
  @ApiProperty({
    description: 'Email address, phone number, device token or webhook URL',
    example: 'jane@example.com',
  })
  @IsString()
  @IsNotEmpty()
  recipient: string;

  // Required for email, optional otherwise. May use {{placeholders}} from `data`.
  @ApiPropertyOptional({
    description: 'Required for email. Supports {{placeholders}} from `data`.',
    example: 'Welcome to {{appName}}, {{name}}!',
  })
  @ValidateIf(
    (o: SendNotificationDto) =>
      o.channel === NotificationChannel.Email || o.subject !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject?: string;

  // Plain-text content. Required unless a template is used.
  @ApiPropertyOptional({
    description: 'Plain-text content. Required when no template is given.',
    example: 'Thanks for signing up.',
  })
  @ValidateIf((o: SendNotificationDto) => !o.template || o.body !== undefined)
  @IsString()
  @IsNotEmpty()
  body?: string;

  // Email template name = file name in src/views (without .html).
  @ApiPropertyOptional({
    description: 'Email template from src/views (e.g. welcome, otp)',
    example: 'welcome',
  })
  @IsOptional()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'template may only contain lowercase letters, digits and dashes',
  })
  template?: string;

  // Values for the template placeholders.
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { name: 'Jane', actionUrl: 'https://example.com/start' },
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
