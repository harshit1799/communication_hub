/**
 * communication_hub.v1.NotificationService (tenant API key). Transport
 * layer only: decodes proto messages, validates, maps results back; the
 * logic lives in NotificationService. Sends are asynchronous: the response
 * carries the stored notification (QUEUED); its outcome is read with
 * GetNotification.
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import { ListNotificationsDto, NotificationIdDto, SendBulkNotificationDto, SendNotificationDto } from '../../dto/index.js';
import {
  ChannelCodec,
  compact,
  nonEmptyMap,
  PriorityCodec,
  ProtoStruct,
  ProtoTimestamp,
  StatusCodec,
  Struct,
  Timestamp,
} from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { Notification, NotificationAttempt } from '../../models/index.js';
import { RequestContextStore } from '../../utils/request-context.js';
import { NotificationService } from './notification.service.js';

const SERVICE = 'NotificationService';

/** NotificationInput as decoded by proto-loader. */
interface ProtoNotificationInput {
  channel?: string;
  recipient?: string;
  userId?: string;
  subject?: string;
  body?: string;
  template?: string;
  templateVersion?: number;
  data?: ProtoStruct;
  metadata?: Record<string, string>;
  priority?: string;
  scheduledAt?: ProtoTimestamp;
  idempotencyKey?: string;
  senderId?: string;
  alsoPush?: boolean;
}

/** Proto input -> plain object for SendNotificationDto validation. */
function decodeInput(input: ProtoNotificationInput = {}) {
  return compact({
    ...input,
    channel: ChannelCodec.decode(input.channel),
    priority: PriorityCodec.decode(input.priority),
    data: Struct.decode(input.data),
    metadata: nonEmptyMap(input.metadata),
    scheduledAt: Timestamp.decode(input.scheduledAt),
  });
}

/** Domain -> proto Notification. */
export function toProtoNotification(n: Notification) {
  return compact({
    id: n.id,
    channel: ChannelCodec.encode(n.channel),
    recipient: n.recipient,
    userId: n.userId,
    subject: n.subject,
    body: n.body,
    template: n.template,
    templateVersion: n.templateVersion,
    data: Struct.encode(n.data),
    metadata: n.metadata ?? {},
    status: StatusCodec.encode(n.status),
    priority: PriorityCodec.encode(n.priority),
    idempotencyKey: n.idempotencyKey,
    attempts: n.attempts ?? 0,
    provider: n.provider,
    providerMessageId: n.providerMessageId,
    error: n.error,
    senderId: n.senderId,
    alsoPush: n.alsoPush ?? false,
    scheduledAt: Timestamp.encode(n.scheduledAt),
    sentAt: Timestamp.encode(n.sentAt),
    createdAt: Timestamp.encode(n.createdAt),
    updatedAt: Timestamp.encode(n.updatedAt),
  });
}

const toProtoAttempt = (a: NotificationAttempt) =>
  compact({
    attempt: a.attempt,
    provider: a.provider,
    sender: a.sender,
    success: a.success,
    providerMessageId: a.providerMessageId,
    error: a.error,
    permanent: a.permanent,
    durationMs: a.durationMs,
    createdAt: Timestamp.encode(a.createdAt),
  });

@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @GrpcMethod(SERVICE, 'SendNotification')
  async send(@Payload() req: { notification?: ProtoNotificationInput }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(SendNotificationDto, decodeInput(req.notification));
    const { notification, replayed } = await this.notifications.send(tenant.tenantId, dto, this.requestId());
    return { notification: toProtoNotification(notification), replayed };
  }

  @GrpcMethod(SERVICE, 'SendBulkNotifications')
  async sendBulk(@Payload() req: { notifications?: ProtoNotificationInput[] }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(SendBulkNotificationDto, { notifications: (req.notifications ?? []).map(decodeInput) });
    const results = await this.notifications.sendBulk(tenant.tenantId, dto.notifications, this.requestId());
    return {
      accepted: results.length,
      replayed: results.filter((r) => r.replayed).length,
      notifications: results.map((r) => toProtoNotification(r.notification)),
    };
  }

  @GrpcMethod(SERVICE, 'GetNotification')
  async get(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    const n = await this.notifications.findOne(tenant.tenantId, validateInput(NotificationIdDto, req).id);
    return { notification: toProtoNotification(n), attempts: (n.attemptLog ?? []).map(toProtoAttempt) };
  }

  @GrpcMethod(SERVICE, 'ListNotifications')
  async list(
    @Payload() req: { page?: { limit?: number; cursor?: string }; status?: string; channel?: string; recipient?: string; userId?: string },
    @CurrentTenant() tenant: TenantContext,
  ) {
    const dto = validateInput(
      ListNotificationsDto,
      compact({
        limit: req.page?.limit || undefined,
        cursor: req.page?.cursor,
        status: StatusCodec.decode(req.status),
        channel: ChannelCodec.decode(req.channel),
        recipient: req.recipient,
        userId: req.userId,
      }),
    );
    const { data, nextCursor } = await this.notifications.list(tenant.tenantId, dto);
    return { notifications: data.map(toProtoNotification), page: compact({ nextCursor }) };
  }

  @GrpcMethod(SERVICE, 'RetryNotification')
  async retry(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    return toProtoNotification(await this.notifications.retry(tenant.tenantId, validateInput(NotificationIdDto, req).id, this.requestId()));
  }

  @GrpcMethod(SERVICE, 'CancelNotification')
  async cancel(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    return toProtoNotification(await this.notifications.cancel(tenant.tenantId, validateInput(NotificationIdDto, req).id));
  }

  /** Carried into the job, so worker logs correlate with this call. */
  private requestId(): string | undefined {
    return RequestContextStore.current()?.requestId;
  }
}
