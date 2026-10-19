/**
 * /v1/notifications: HTTP layer only; logic lives in NotificationService.
 * Sends return 202 Accepted: the notification is stored and queued, and
 * its final status is available via GET /v1/notifications/:id.
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HEADER } from '../../constant/index.js';
import {
  ApiEnvelope,
  ApiErrors,
  CurrentTenant,
  ResponseMessage,
  TenantAuth,
  type TenantContext,
} from '../../decorator/index.js';
import {
  BulkNotificationResponseDto,
  ListNotificationsDto,
  NotificationDetailsResponseDto,
  NotificationIdDto,
  NotificationListResponseDto,
  NotificationResponseDto,
  SendBulkNotificationDto,
  SendNotificationDto,
} from '../../dto/index.js';
import { SUCCESS } from '../../response/response.js';
import { NotificationService } from './notification.service.js';

/**
 * Tenant-authenticated notification endpoints. The request id is passed
 * to the service so worker logs can be correlated with the request.
 */
@ApiTags('Notifications')
@TenantAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS)
@Controller({ path: 'notifications', version: '1' })
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * Accepts one notification for delivery (202). With an Idempotency-Key, a
   * retried request returns the original notification (also 202) with the
   * `Idempotent-Replayed: true` header, and nothing is sent again.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send an email, SMS or push notification' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique per request (e.g. a UUID). Retrying with the same key never sends twice.',
  })
  @ApiEnvelope(NotificationResponseDto, { status: HttpStatus.ACCEPTED })
  @ApiErrors(HttpStatus.UNPROCESSABLE_ENTITY)
  @ResponseMessage(SUCCESS.NOTIFICATION_ACCEPTED)
  async send(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: SendNotificationDto,
    @Headers(HEADER.IDEMPOTENCY_KEY) idempotencyKey: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { notification, replayed } = await this.notificationService.send(tenant.tenantId, dto, req.id, idempotencyKey);
    if (replayed) reply.header(HEADER.IDEMPOTENT_REPLAYED, 'true');
    return notification;
  }

  /** Accepts up to 500 notifications in one request (202), low priority by default. */
  @Post('bulk')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send up to 500 notifications in one request',
    description: 'Defaults to low priority (campaigns), so single sends are delivered first.',
  })
  @ApiEnvelope(BulkNotificationResponseDto, { status: HttpStatus.ACCEPTED })
  @ResponseMessage(SUCCESS.NOTIFICATIONS_ACCEPTED)
  sendBulk(@CurrentTenant() tenant: TenantContext, @Body() dto: SendBulkNotificationDto, @Req() req: FastifyRequest) {
    return this.notificationService.sendBulk(tenant.tenantId, dto.notifications, req.id);
  }

  /** Lists the tenant's notifications, newest first. */
  @Get()
  @ApiOperation({ summary: 'List notifications, newest first (cursor pagination)' })
  @ApiEnvelope(NotificationListResponseDto)
  @ResponseMessage(SUCCESS.NOTIFICATION_LISTING)
  list(@CurrentTenant() tenant: TenantContext, @Query() query: ListNotificationsDto) {
    return this.notificationService.list(tenant.tenantId, query);
  }

  /** One notification with its attempt log. 404 for other tenants' ids. */
  @Get(':id')
  @ApiOperation({ summary: 'Get a notification with its delivery attempts' })
  @ApiEnvelope(NotificationDetailsResponseDto)
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.NOTIFICATION_DETAILS)
  findOne(@CurrentTenant() tenant: TenantContext, @Param() { id }: NotificationIdDto) {
    return this.notificationService.findOne(tenant.tenantId, id);
  }

  /** Re-queues a failed notification. 409 if it isn't failed. */
  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry a failed notification' })
  @ApiEnvelope(NotificationResponseDto, { status: HttpStatus.ACCEPTED })
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  @ResponseMessage(SUCCESS.NOTIFICATION_RETRIED)
  retry(@CurrentTenant() tenant: TenantContext, @Param() { id }: NotificationIdDto, @Req() req: FastifyRequest) {
    return this.notificationService.retry(tenant.tenantId, id, req.id);
  }

  /** Cancels an undelivered notification. 409 if it already moved on. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a queued, scheduled or retrying notification' })
  @ApiEnvelope(NotificationResponseDto)
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  @ResponseMessage(SUCCESS.NOTIFICATION_CANCELLED)
  cancel(@CurrentTenant() tenant: TenantContext, @Param() { id }: NotificationIdDto) {
    return this.notificationService.cancel(tenant.tenantId, id);
  }
}
