/**
 * communication_hub.v1.InboxService (tenant API key).
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import { InboxMessageRefDto, InboxUserDto, ListInboxMessagesDto, MarkInboxMessagesReadDto } from '../../dto/index.js';
import { compact, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { InboxMessage } from '../../models/index.js';
import { InboxService } from './inbox.service.js';

const SERVICE = 'InboxService';

const toProtoMessage = (m: InboxMessage) =>
  compact({
    id: m.id,
    userId: m.userId,
    notificationId: m.notificationId,
    title: m.title,
    body: m.body,
    metadata: m.metadata ?? {},
    read: m.readAt !== null,
    readAt: Timestamp.encode(m.readAt),
    createdAt: Timestamp.encode(m.createdAt),
    expiresAt: Timestamp.encode(m.expiresAt),
  });

@Controller()
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @GrpcMethod(SERVICE, 'ListInboxMessages')
  async list(@Payload() req: { userId?: string; page?: { limit?: number; cursor?: string }; unreadOnly?: boolean }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(
      ListInboxMessagesDto,
      compact({ userId: req.userId, limit: req.page?.limit || undefined, cursor: req.page?.cursor, unreadOnly: req.unreadOnly ?? false }),
    );
    const { data, nextCursor, unreadCount } = await this.inbox.list(tenant.tenantId, dto);
    return { messages: data.map(toProtoMessage), page: compact({ nextCursor }), unreadCount };
  }

  @GrpcMethod(SERVICE, 'GetUnreadCount')
  async unreadCount(@Payload() req: { userId?: string }, @CurrentTenant() tenant: TenantContext) {
    return { unreadCount: await this.inbox.unreadCount(tenant.tenantId, validateInput(InboxUserDto, req).userId) };
  }

  @GrpcMethod(SERVICE, 'MarkInboxMessagesRead')
  async markRead(@Payload() req: { userId?: string; ids?: string[] }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(MarkInboxMessagesReadDto, { userId: req.userId, ids: req.ids ?? [] });
    return { unreadCount: await this.inbox.markRead(tenant.tenantId, dto) };
  }

  @GrpcMethod(SERVICE, 'MarkAllInboxMessagesRead')
  async markAllRead(@Payload() req: { userId?: string }, @CurrentTenant() tenant: TenantContext) {
    return { unreadCount: await this.inbox.markAllRead(tenant.tenantId, validateInput(InboxUserDto, req).userId) };
  }

  @GrpcMethod(SERVICE, 'DeleteInboxMessage')
  async remove(@Payload() req: { userId?: string; id?: string }, @CurrentTenant() tenant: TenantContext) {
    return { unreadCount: await this.inbox.remove(tenant.tenantId, validateInput(InboxMessageRefDto, req)) };
  }
}
