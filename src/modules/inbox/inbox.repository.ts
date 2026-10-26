/**
 * Data access for `inbox_messages`. Every query is scoped by tenant and
 * user; expired rows are invisible before the purge deletes them.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { BaseRepository, CursorPage } from '../../database/postgres/base.repository.js';
import { InboxMessage } from '../../models/index.js';

/** What the worker writes for one in-app notification. */
export interface NewInboxMessage {
  tenantId: string;
  userId: string;
  notificationId: string;
  title: string | null;
  body: string;
  metadata: Record<string, string>;
  expiresAt: Date;
}

@Injectable()
export class InboxRepository extends BaseRepository<InboxMessage> {
  constructor(@InjectRepository(InboxMessage) repository: Repository<InboxMessage>) {
    super(repository);
  }

  /**
   * Stores the message once per notification: a retried job finds the row
   * from its first attempt (ON CONFLICT DO NOTHING) and returns it.
   */
  async store(message: NewInboxMessage): Promise<InboxMessage> {
    await this.repository
      .createQueryBuilder()
      .insert()
      .into(InboxMessage)
      .values(message)
      .orIgnore()
      .updateEntity(false)
      .execute();
    return (await this.findOne({ notificationId: message.notificationId }))!;
  }

  /** The user's live messages, newest first. */
  list(tenantId: string, userId: string, query: { unreadOnly: boolean; limit: number; cursor?: string }): Promise<CursorPage<InboxMessage>> {
    const qb = this.queryBuilder('m')
      .where('m.tenant_id = :tenantId AND m.user_id = :userId AND m.expires_at > now()', { tenantId, userId });
    if (query.unreadOnly) qb.andWhere('m.read_at IS NULL');
    return this.paginateByCursor(qb, 'm', query.limit, query.cursor);
  }

  unreadCount(tenantId: string, userId: string): Promise<number> {
    return this.count({ tenantId, userId, readAt: IsNull(), expiresAt: MoreThan(new Date()) });
  }

  /** Marks messages read (ids of other users are ignored). */
  async markRead(tenantId: string, userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.updateWhere({ tenantId, userId, id: In(ids), readAt: IsNull() }, { readAt: new Date() });
  }

  async markAllRead(tenantId: string, userId: string): Promise<void> {
    await this.updateWhere({ tenantId, userId, readAt: IsNull() }, { readAt: new Date() });
  }

  /** Returns false when the user has no such message. */
  async remove(tenantId: string, userId: string, id: string): Promise<boolean> {
    return (await this.deleteWhere({ tenantId, userId, id })) > 0;
  }

  /**
   * Deletes up to `batch` expired messages. Small batches keep locks and
   * WAL bursts short; the caller loops until nothing is left.
   */
  async purgeExpired(batch: number): Promise<number> {
    const rows = await this.rawQuery<{ id: string }>(
      `DELETE FROM inbox_messages
        WHERE id IN (SELECT id FROM inbox_messages WHERE expires_at < now() LIMIT $1)
    RETURNING id`,
      [batch],
    );
    return rows.length;
  }
}
