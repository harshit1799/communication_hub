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
import { ListNotificationsDto, NotificationIdDto, SendNotificationDto } from '../../dto/index.js';
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
import type { QueueSnapshot } from './notification.queue.js';
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
  from?: string;
  alsoPush?: boolean;
}

/** BulkNotificationInput: NotificationInput plus the target lists (fanned out by NotificationService). */
interface ProtoBulkNotificationInput extends ProtoNotificationInput {
  recipients?: string[];
  userIds?: string[];
}

/** Proto input -> plain object for SendNotificationDto validation. */
function decodeInput(input: ProtoBulkNotificationInput = {}) {
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
    from: n.fromAddress,
    sentFrom: n.sentFrom,
    providerName: n.providerName,
    alsoPush: n.alsoPush ?? false,
    scheduledAt: Timestamp.encode(n.scheduledAt),
    sentAt: Timestamp.encode(n.sentAt),
    createdAt: Timestamp.encode(n.createdAt),
    updatedAt: Timestamp.encode(n.updatedAt),
  });
}

/** Domain -> proto QueueInfo (omitted when the queue couldn't be read). */
const toProtoQueue = (q: QueueSnapshot | null) =>
  q
    ? compact({
        queue: q.queue,
        jobId: q.jobId,
        state: q.state,
        priority: q.priority,
        attemptsMade: q.attemptsMade,
        maxAttempts: q.maxAttempts,
        runAt: Timestamp.encode(q.runAt),
      })
    : undefined;

const toProtoAttempt = (a: NotificationAttempt) =>
  compact({
    attempt: a.attempt,
    provider: a.provider,
    sender: a.sender,
    providerName: a.providerName,
    providerId: a.providerConfigId,
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
    const { notification, replayed, attempts, queue } = await this.notifications.send(tenant.tenantId, dto, this.requestId());
    return compact({
      notification: toProtoNotification(notification),
      replayed,
      attempts: attempts.map(toProtoAttempt),
      queue: toProtoQueue(queue),
    });
  }

  @GrpcMethod(SERVICE, 'SendBulkNotifications')
  async sendBulk(@Payload() req: { notifications?: ProtoBulkNotificationInput[] }, @CurrentTenant() tenant: TenantContext) {
    // Size check, fan-out and validation happen in the service.
    const items = (req.notifications ?? []).map((input) => decodeInput(input));
    const results = await this.notifications.sendBulk(tenant.tenantId, items, this.requestId());
    return {
      accepted: results.length,
      replayed: results.filter((r) => r.replayed).length,
      notifications: results.map((r) => toProtoNotification(r.notification)),
      queues: results.map((r) => toProtoQueue(r.queue) ?? {}),
    };
  }

  @GrpcMethod(SERVICE, 'GetNotification')
  async get(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    const { notification: n, queue } = await this.notifications.findOne(tenant.tenantId, validateInput(NotificationIdDto, req).id);
    return compact({ notification: toProtoNotification(n), attempts: (n.attemptLog ?? []).map(toProtoAttempt), queue: toProtoQueue(queue) });
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
