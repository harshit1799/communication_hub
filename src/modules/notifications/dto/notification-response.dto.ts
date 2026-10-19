/**
 * Response body of POST /api/v1/notifications (a row of the notifications
 * table). Exists mainly so Swagger can document exactly what the API returns.
 */

// Swagger decorators for required and optional properties.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// Enums shown as allowed values in the docs.
import { NotificationChannel } from '../enums/notification-channel.enum.js';
import { NotificationStatus } from '../enums/notification-status.enum.js';

export class NotificationResponseDto {
  // Unique id (UUID), the primary key in the database.
  @ApiProperty({ format: 'uuid' })
  id: string;

  // Owning tenant.
  @ApiProperty({ example: 'acme' })
  tenantId: string;

  // Delivery channel.
  @ApiProperty({ enum: NotificationChannel })
  channel: NotificationChannel;

  // Destination address/number/token/URL.
  @ApiProperty()
  recipient: string;

  // Final (rendered) subject.
  @ApiPropertyOptional({ type: String, nullable: true })
  subject: string | null;

  // Plain-text content.
  @ApiPropertyOptional({ type: String, nullable: true })
  body: string | null;

  // Template used, if any.
  @ApiPropertyOptional({ type: String, nullable: true, example: 'welcome' })
  template: string | null;

  // Values used to fill the template.
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  data: Record<string, unknown> | null;

  // Delivery result.
  @ApiProperty({ enum: NotificationStatus })
  status: NotificationStatus;

  // Vendor message id when sent.
  @ApiPropertyOptional({ type: String, nullable: true })
  providerMessageId: string | null;

  // Failure reason when failed.
  @ApiPropertyOptional({ type: String, nullable: true })
  error: string | null;

  // Creation time (serialized to an ISO string in JSON).
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  // Last update time.
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
