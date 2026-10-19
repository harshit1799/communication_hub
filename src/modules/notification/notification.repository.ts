/**
 * Data access for the `notifications` table.
 *
 * Status transitions are conditional updates (WHERE status IN ...), so a
 * worker and a client cancelling the same notification can't both win.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { Cursor } from '../../common/dtos/common.dtos.js';
import { IN_FLIGHT_STATUSES, NotificationStatus } from '../../constant/index.js';
import { ListNotificationsDto } from '../../dto/index.js';
import { Notification } from '../../models/index.js';

/** Columns supplied on insert (the rest have database defaults). */
export type NewNotification = Omit<
  Notification,
  'tenant' | 'attemptLog' | 'createdAt' | 'updatedAt' | 'attempts' | 'provider' | 'providerMessageId' | 'error' | 'sentAt'
>;

/** Every tenant-facing query is scoped by tenant id. */
@Injectable()
export class NotificationRepository {
  constructor(
    @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
  ) {}

  /**
   * Inserts the rows in one statement. Rows whose idempotency key already
   * exists for the tenant are skipped, and the original rows are returned
   * in `duplicates` instead.
   */
  async insertIdempotent(
    tenantId: string,
    rows: NewNotification[],
  ): Promise<{ inserted: Notification[]; duplicates: Notification[] }> {
    await this.notifications
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values(rows as QueryDeepPartialEntity<Notification>[])
      .orIgnore()
      // TypeORM would otherwise copy RETURNING ids back onto `rows` by
      // position, which is wrong as soon as a duplicate row is skipped.
      .updateEntity(false)
      .execute();

    const ids = rows.map((r) => r.id);
    const inserted = await this.notifications.findBy({ id: In(ids) });
    const insertedIds = new Set(inserted.map((n) => n.id));
    const duplicateKeys = rows
      .filter((r) => !insertedIds.has(r.id) && r.idempotencyKey)
      .map((r) => r.idempotencyKey!);
    const duplicates = duplicateKeys.length
      ? await this.notifications.findBy({ tenantId, idempotencyKey: In(duplicateKeys) })
      : [];
    return { inserted, duplicates };
  }

  /** A notification of this tenant, or null. */
  findForTenant(tenantId: string, id: string): Promise<Notification | null> {
    return this.notifications.findOneBy({ tenantId, id });
  }

  /** A notification of this tenant with its attempts in order, or null. */
  findWithAttempts(tenantId: string, id: string): Promise<Notification | null> {
    return this.notifications.findOne({
      where: { tenantId, id },
      relations: { attemptLog: true },
      order: { attemptLog: { attempt: 'ASC' } },
    });
  }

  /** For workers: the notification with its tenant (branding/senders). */
  findWithTenant(id: string): Promise<Notification | null> {
    return this.notifications.findOne({ where: { id }, relations: { tenant: true } });
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  async list(tenantId: string, query: ListNotificationsDto) {
    const qb = this.notifications
      .createQueryBuilder('n')
      .where('n.tenant_id = :tenantId', { tenantId })
      .orderBy('n.created_at', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(query.limit + 1);

    if (query.status) qb.andWhere('n.status = :status', { status: query.status });
    if (query.channel) qb.andWhere('n.channel = :channel', { channel: query.channel });
    if (query.recipient) qb.andWhere('n.recipient = :recipient', { recipient: query.recipient });
    if (query.userId) qb.andWhere('n.user_id = :userId', { userId: query.userId });
    const cursor = query.cursor ? Cursor.decode(query.cursor) : null;
    if (cursor) {
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('n.created_at < :createdAt', cursor)
            .orWhere('(n.created_at = :createdAt AND n.id < :id)', cursor),
        ),
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const last = data.at(-1);
    return {
      data,
      nextCursor: hasMore && last ? Cursor.encode(last.createdAt, last.id) : null,
    };
  }

  /**
   * Claims the notification for a delivery attempt. Returns the attempt
   * number, or null when it is no longer deliverable (sent, cancelled, ...).
   */
  async markProcessing(id: string): Promise<number | null> {
    const [rows] = (await this.notifications.query(
      `UPDATE notifications
          SET status = $2, attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = ANY($3)
    RETURNING attempts`,
      [id, NotificationStatus.Processing, IN_FLIGHT_STATUSES],
    )) as [{ attempts: number }[], number];
    return rows[0]?.attempts ?? null;
  }

  /** processing -> sent, with the vendor's message id. */
  async markSent(id: string, provider: string, providerMessageId: string): Promise<void> {
    await this.notifications.update(
      { id, status: NotificationStatus.Processing },
      { status: NotificationStatus.Sent, provider, providerMessageId, error: null, sentAt: new Date() },
    );
  }

  /** processing -> retrying (more attempts left) or failed (final). */
  async markFailure(
    id: string,
    status: NotificationStatus.Retrying | NotificationStatus.Failed,
    provider: string,
    error: string,
  ): Promise<void> {
    await this.notifications.update(
      { id, status: NotificationStatus.Processing },
      { status, provider, error },
    );
  }

  /** failed -> queued (manual retry). Returns false if it wasn't failed. */
  async requeueFailed(id: string): Promise<boolean> {
    const result = await this.notifications.update(
      { id, status: NotificationStatus.Failed },
      { status: NotificationStatus.Queued, error: null },
    );
    return (result.affected ?? 0) > 0;
  }

  /** queued | retrying -> cancelled. Returns false if it already moved on. */
  async cancel(id: string): Promise<boolean> {
    const result = await this.notifications.update(
      { id, status: In([NotificationStatus.Queued, NotificationStatus.Retrying]) },
      { status: NotificationStatus.Cancelled },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * In-flight notifications that haven't changed for a while and are due.
   * Their `updated_at` is bumped so the next sweep doesn't pick them again.
   */
  async claimStuck(olderThan: Date, limit: number): Promise<Notification[]> {
    const rows = (await this.notifications.query(
      `UPDATE notifications SET updated_at = now()
        WHERE id IN (
          SELECT id FROM notifications
           WHERE status = ANY($1)
             AND updated_at < $2
             AND (scheduled_at IS NULL OR scheduled_at <= now())
           ORDER BY updated_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
    RETURNING id, channel, priority, scheduled_at`,
      [IN_FLIGHT_STATUSES, olderThan, limit],
    )) as [{ id: string; channel: string; priority: string; scheduled_at: Date | null }[], number];
    return rows[0].map((r) =>
      this.notifications.create({
        id: r.id,
        channel: r.channel as Notification['channel'],
        priority: r.priority as Notification['priority'],
        scheduledAt: r.scheduled_at,
      }),
    );
  }
}
