/**
 * In-app inbox: reads and state changes through InboxService (gRPC), and
 * the worker-side write for CHANNEL_IN_APP notifications.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cursor } from '../../common/dtos/common.dtos.js';
import { AppConfig } from '../../config/configuration.js';
import { LIMITS } from '../../constant/index.js';
import { InboxMessageRefDto, ListInboxMessagesDto, MarkInboxMessagesReadDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { InboxMessage, Notification } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { CursorPage } from '../../database/postgres/base.repository.js';
import { InboxRepository } from './inbox.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class InboxService {
  private readonly retentionMs: number;

  constructor(
    private readonly inbox: InboxRepository,
    config: ConfigService,
  ) {
    this.retentionMs = config.getOrThrow<AppConfig>('app').queue.inboxRetentionDays * DAY_MS;
  }

  // ---------- Worker ----------

  /** Writes the inbox row for an in-app notification (idempotent per notification). */
  deliver(n: Notification, content: { title?: string; body?: string }): Promise<InboxMessage> {
    return this.inbox.store({
      tenantId: n.tenantId,
      userId: n.userId!,
      notificationId: n.id,
      title: content.title ?? null,
      body: content.body ?? '',
      metadata: n.metadata ?? {},
      expiresAt: new Date(Date.now() + this.retentionMs),
    });
  }

  // ---------- API ----------

  async list(tenantId: string, dto: ListInboxMessagesDto): Promise<CursorPage<InboxMessage> & { unreadCount: number }> {
    if (dto.cursor && !Cursor.decode(dto.cursor)) {
      throw new AppException(ERROR.VALIDATION_ERROR, { errors: ['cursor is invalid'] }, { detail: 'cursor is invalid' });
    }
    const [page, unreadCount] = await Promise.all([
      this.inbox.list(tenantId, dto.userId, { unreadOnly: dto.unreadOnly, limit: dto.limit, cursor: dto.cursor }),
      this.inbox.unreadCount(tenantId, dto.userId),
    ]);
    return { ...page, unreadCount };
  }

  unreadCount(tenantId: string, userId: string): Promise<number> {
    return this.inbox.unreadCount(tenantId, userId);
  }

  async markRead(tenantId: string, dto: MarkInboxMessagesReadDto): Promise<number> {
    await this.inbox.markRead(tenantId, dto.userId, dto.ids.slice(0, LIMITS.INBOX_MARK_MAX));
    return this.inbox.unreadCount(tenantId, dto.userId);
  }

  async markAllRead(tenantId: string, userId: string): Promise<number> {
    await this.inbox.markAllRead(tenantId, userId);
    return this.inbox.unreadCount(tenantId, userId);
  }

  async remove(tenantId: string, dto: InboxMessageRefDto): Promise<number> {
    if (!(await this.inbox.remove(tenantId, dto.userId, dto.id))) throw new AppException(ERROR.INBOX_MESSAGE_NOT_FOUND);
    return this.inbox.unreadCount(tenantId, dto.userId);
  }

  // ---------- Maintenance ----------

  /** Deletes every expired message, batch by batch. Returns how many. */
  async purgeExpired(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.inbox.purgeExpired(LIMITS.INBOX_PURGE_BATCH);
      total += deleted;
      if (deleted < LIMITS.INBOX_PURGE_BATCH) return total;
    }
  }
}
