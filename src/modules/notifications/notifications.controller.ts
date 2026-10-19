/**
 * HTTP layer for notifications. Maps POST /api/v1/notifications to the
 * service; contains no business logic itself.
 */

// Route and parameter decorators.
import { Body, Controller, Post } from '@nestjs/common';
// Swagger decorators documenting operations and responses.
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
// Tenant header name and the decorator that reads it.
import { TENANT_HEADER } from '../../common/constants.js';
import { TenantId } from '../../common/decorators/tenant-id.decorator.js';
// Standard error body for Swagger docs.
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
// Request/response DTOs.
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import { SendNotificationDto } from './dto/send-notification.dto.js';
// Business logic.
import { NotificationsService } from './notifications.service.js';

// Group these routes under "Notifications" in Swagger UI.
@ApiTags('Notifications')
// Tell Swagger these routes need the x-tenant-id header (Authorize button).
@ApiSecurity(TENANT_HEADER)
// Every route here can return 400 with the standard error body.
@ApiBadRequestResponse({ type: ErrorResponseDto })
// Base path /notifications, served as version 1 -> /api/v1/notifications.
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // POST /api/v1/notifications
  @Post()
  @ApiOperation({
    summary: 'Send a notification (plain or from an email template)',
  })
  @ApiCreatedResponse({ type: NotificationResponseDto })
  send(
    // Tenant id from the x-tenant-id header.
    @TenantId() tenantId: string,
    // Validated request body.
    @Body() dto: SendNotificationDto,
  ): Promise<NotificationResponseDto> {
    // Delegate to the service; Nest responds with 201 Created by default.
    return this.notificationsService.send(tenantId, dto);
  }
}
