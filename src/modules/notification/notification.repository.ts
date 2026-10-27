/**
 * Data access for the `notifications` table. `recipient` and `data` are
 * encrypted/decrypted transparently by their column transformers.
 *
 * Status transitions are conditional updates (WHERE status IN ...), so a
 * worker and a client cancelling the same notification can't both win.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { BaseRepository, CursorPage } from '../../database/postgres/base.repository.js';
import { IN_FLIGHT_STATUSES, NotificationStatus } from '../../constant/index.js';
import { NotificationChannel } from '../../constant/index.js';
import { Notification } from '../../models/index.js';

/** Columns supplied on insert (the rest have database defaults). */
export type NewNotification = Omit<
  Notification,
  | 'tenant'
  | 'templateRef'
  | 'attemptLog'
  | 'createdAt'
  | 'updatedAt'
  | 'attempts'
  | 'provider'
  | 'providerMessageId'
  | 'error'
  | 'sentAt'
  | 'sentFrom'
  | 'providerName'
>;

/** Filters of ListNotifications; the recipient arrives as its blind index. */
export interface NotificationFilter {
  status?: NotificationStatus;
  channel?: NotificationChannel;
  recipientHash?: string;
  userId?: string;
  limit: number;
  cursor?: string;
}

/** Every tenant-facing query is scoped by tenant id. */
@Injectable()
export class NotificationRepository extends BaseRepository<Notification> {
  constructor(@InjectRepository(Notification) repository: Repository<Notification>) {
    super(repository);
  }

  /**
   * Inserts the rows in one statement. Rows whose idempotency key already
   * exists for the tenant are skipped, and the original rows are returned
   * in `duplicates` instead.
   */
  async insertIdempotent(
    tenantId: string,
    rows: NewNotification[],
  ): Promise<{ inserted: Notification[]; duplicates: Notification[] }> {
    await this.repository
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values(rows as QueryDeepPartialEntity<Notification>[])
      .orIgnore()
      // TypeORM would otherwise copy RETURNING ids back onto `rows` by
      // position, which is wrong as soon as a duplicate row is skipped.
      .updateEntity(false)
      .execute();

    const inserted = await this.findMany({ id: In(rows.map((r) => r.id)) });
    const insertedIds = new Set(inserted.map((n) => n.id));
    const duplicateKeys = rows
      .filter((r) => !insertedIds.has(r.id) && r.idempotencyKey)
      .map((r) => r.idempotencyKey!);
    const duplicates = duplicateKeys.length
      ? await this.findMany({ tenantId, idempotencyKey: In(duplicateKeys) })
      : [];
    return { inserted, duplicates };
  }

  /** A notification of this tenant, or null. */
  findForTenant(tenantId: string, id: string): Promise<Notification | null> {
    return this.findOne({ tenantId, id });
  }

  /** A notification of this tenant with its attempts in order, or null. */
  findWithAttempts(tenantId: string, id: string): Promise<Notification | null> {
    return this.findOne({ tenantId, id }, { relations: { attemptLog: true }, order: { attemptLog: { attempt: 'ASC' } } });
  }

  /** For workers: the notification with its tenant (branding). */
  findWithTenant(id: string): Promise<Notification | null> {
    return this.findOne({ id }, { relations: { tenant: true } });
  }

  /** The tenant's notifications, newest first, filtered and cursor-paginated. */
  list(tenantId: string, query: NotificationFilter): Promise<CursorPage<Notification>> {
    const qb = this.queryBuilder('n').where('n.tenant_id = :tenantId', { tenantId });
    if (query.status) qb.andWhere('n.status = :status', { status: query.status });
    if (query.channel) qb.andWhere('n.channel = :channel', { channel: query.channel });
    if (query.recipientHash) qb.andWhere('n.recipient_hash = :hash', { hash: query.recipientHash });
    if (query.userId) qb.andWhere('n.user_id = :userId', { userId: query.userId });
    return this.paginateByCursor(qb, 'n', query.limit, query.cursor);
  }

  /**
   * Claims the notification for a delivery attempt. Returns the attempt
   * number, or null when it is no longer deliverable (sent, cancelled, ...).
   * Raw SQL: needs UPDATE ... RETURNING to claim and count in one step.
   */
  async markProcessing(id: string): Promise<number | null> {
    const [row] = await this.rawQuery<{ attempts: number }>(
      `UPDATE notifications
          SET status = $2, attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = ANY($3)
    RETURNING attempts`,
      [id, NotificationStatus.Processing, IN_FLIGHT_STATUSES],
    );
    return row?.attempts ?? null;
  }

  /** processing -> sent, with the vendor's message id, the From used and the provider config name. */
  async markSent(
    id: string,
    provider: string,
    providerMessageId: string,
    via: { sentFrom: string | null; providerName: string | null },
  ): Promise<void> {
    await this.updateWhere(
      { id, status: NotificationStatus.Processing },
      { status: NotificationStatus.Sent, provider, providerMessageId, error: null, sentAt: new Date(), sentFrom: via.sentFrom, providerName: via.providerName },
    );
  }

  /** processing -> retrying (more attempts left) or failed (final). */
  async markFailure(
    id: string,
    status: NotificationStatus.Retrying | NotificationStatus.Failed,
    provider: string,
    error: string,
    providerName: string | null = null,
  ): Promise<void> {
    await this.updateWhere({ id, status: NotificationStatus.Processing }, { status, provider, error, providerName });
  }

  /** failed -> queued (manual retry). Returns false if it wasn't failed. */
  async requeueFailed(id: string): Promise<boolean> {
    return (await this.updateWhere({ id, status: NotificationStatus.Failed }, { status: NotificationStatus.Queued, error: null })) > 0;
  }

  /** queued | retrying -> cancelled. Returns false if it already moved on. */
  async cancel(id: string): Promise<boolean> {
    const changed = await this.updateWhere(
      { id, status: In([NotificationStatus.Queued, NotificationStatus.Retrying]) },
      { status: NotificationStatus.Cancelled },
    );
    return changed > 0;
  }

  /**
   * In-flight notifications that haven't changed for a while and are due.
   * Their `updated_at` is bumped so the next sweep doesn't pick them again.
   * Raw SQL: FOR UPDATE SKIP LOCKED lets several sweepers run without
   * claiming the same rows.
   */
  async claimStuck(olderThan: Date, limit: number): Promise<Notification[]> {
    const rows = await this.rawQuery<{ id: string; channel: string; priority: string; scheduled_at: Date | null }>(
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
    );
    return rows.map((r) =>
      this.repository.create({
        id: r.id,
        channel: r.channel as Notification['channel'],
        priority: r.priority as Notification['priority'],
        scheduledAt: r.scheduled_at,
      }),
    );
  }
}
