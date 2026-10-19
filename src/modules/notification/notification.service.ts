/**
 * API-side notification logic: validate, persist, enqueue. Delivery itself
 * happens asynchronously in the workers (notification.dispatcher.ts), so the
 * API stays fast and vendor outages never block clients.
 *
 * Reliability: the row is committed before the job is enqueued. If
 * enqueueing fails the request still succeeds (the notification is durably
 * accepted) and the maintenance sweeper enqueues it shortly after.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Cursor } from '../../common/dtos/common.dtos.js';
import { LIMITS, NotificationPriority, NotificationStatus } from '../../constant/index.js';
import {
  BulkNotificationResponseDto,
  ListNotificationsDto,
  NotificationDetailsResponseDto,
  NotificationListResponseDto,
  NotificationResponseDto,
  SendNotificationDto,
} from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { Notification } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { errorMessage } from '../../utils/appUtils.js';
import { TemplateService } from '../../utils/template/template.service.js';
import { NotificationQueue } from './notification.queue.js';
import { NewNotification, NotificationRepository } from './notification.repository.js';

/** One day in milliseconds (scheduling limit). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Used by NotificationController; never talks to vendors directly. */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly queue: NotificationQueue,
    private readonly templates: TemplateService,
  ) {}

  /**
   * Accepts one notification. Returns the stored row (status `queued`), or
   * for a repeated idempotency key the original row with `replayed: true`
   * (nothing is sent again). The key comes from the Idempotency-Key header
   * or the body's idempotencyKey; if both are given they must match.
   */
  async send(
    tenantId: string,
    dto: SendNotificationDto,
    requestId?: string,
    headerKey?: string,
  ): Promise<{ notification: NotificationResponseDto; replayed: boolean }> {
    const idempotencyKey = this.resolveIdempotencyKey(headerKey, dto.idempotencyKey);
    // Single sends default to normal priority: ahead of bulk (low) campaigns.
    const [result] = await this.sendMany(tenantId, [{ ...dto, idempotencyKey }], NotificationPriority.Normal, requestId);
    return result;
  }

  /** Accepts many notifications in one insert and one enqueue per channel. */
  async sendBulk(
    tenantId: string,
    dtos: SendNotificationDto[],
    requestId?: string,
  ): Promise<BulkNotificationResponseDto> {
    // Bulk sends (campaigns) default to low priority, so single sends such as
    // login OTPs are delivered first even while a large campaign is queued.
    const results = await this.sendMany(tenantId, dtos, NotificationPriority.Low, requestId);
    return {
      accepted: results.length,
      replayed: results.filter((r) => r.replayed).length,
      notifications: results.map((r) => r.notification),
    };
  }

  /** One page of the tenant's notifications. Throws 400 on a bad cursor. */
  async list(tenantId: string, query: ListNotificationsDto): Promise<NotificationListResponseDto> {
    if (query.cursor && !Cursor.decode(query.cursor)) {
      throw new AppException(ERROR.VALIDATION_ERROR, { errors: ['cursor is invalid'] });
    }
    const { data, nextCursor } = await this.notifications.list(tenantId, query);
    return { data: data.map((n) => this.toDto(n)), nextCursor };
  }

  /** A notification with its attempt log. Throws NOTIFICATION_NOT_FOUND. */
  async findOne(tenantId: string, id: string): Promise<NotificationDetailsResponseDto> {
    const n = await this.notifications.findWithAttempts(tenantId, id);
    if (!n) throw new AppException(ERROR.NOTIFICATION_NOT_FOUND);
    return {
      ...this.toDto(n),
      attemptLog: (n.attemptLog ?? []).map((a) => ({
        attempt: a.attempt,
        provider: a.provider,
        success: a.success,
        providerMessageId: a.providerMessageId,
        error: a.error,
        permanent: a.permanent,
        durationMs: a.durationMs,
        createdAt: a.createdAt,
      })),
    };
  }

  /** Sends a failed notification again (e.g. after fixing a provider). */
  async retry(tenantId: string, id: string, requestId?: string): Promise<NotificationResponseDto> {
    const n = await this.getOwned(tenantId, id);
    if (!(await this.notifications.requeueFailed(n.id))) {
      throw new AppException(ERROR.NOTIFICATION_NOT_RETRYABLE);
    }
    // try/await (not .catch): also covers errors thrown synchronously.
    try {
      await this.queue.ensureEnqueued(n, requestId);
    } catch (err) {
      this.logger.error(`Enqueue failed for ${n.id}, sweeper will retry: ${errorMessage(err)}`);
    }
    return this.toDto({ ...n, status: NotificationStatus.Queued, error: null });
  }

  /** Cancels a notification that hasn't been delivered yet. */
  async cancel(tenantId: string, id: string): Promise<NotificationResponseDto> {
    const n = await this.getOwned(tenantId, id);
    // The status flip is what matters: workers skip cancelled rows even if
    // the job is still in Redis. Removing the job just frees the slot early.
    if (!(await this.notifications.cancel(n.id))) {
      throw new AppException(ERROR.NOTIFICATION_NOT_CANCELLABLE);
    }
    await this.queue.remove(n).catch(() => undefined);
    return this.toDto({ ...n, status: NotificationStatus.Cancelled });
  }

  /**
   * Shared send path: validate everything, insert in one statement,
   * enqueue, then answer in request order.
   */
  private async sendMany(
    tenantId: string,
    dtos: SendNotificationDto[],
    defaultPriority: NotificationPriority,
    requestId?: string,
  ): Promise<{ notification: NotificationResponseDto; replayed: boolean }[]> {
    // Reject bad input before anything is stored.
    dtos.forEach((dto) => this.validate(dto));

    const rows: NewNotification[] = dtos.map((dto) => ({
      id: randomUUID(),
      tenantId,
      channel: dto.channel,
      recipient: dto.recipient ?? null,
      userId: dto.userId ?? null,
      subject: dto.subject ?? null,
      body: dto.body ?? null,
      template: dto.template ?? null,
      data: dto.data ?? null,
      metadata: dto.metadata ?? null,
      status: NotificationStatus.Queued,
      priority: dto.priority ?? defaultPriority,
      idempotencyKey: dto.idempotencyKey ?? null,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
    }));

    const { inserted, duplicates } = await this.notifications.insertIdempotent(tenantId, rows);
    // The rows are committed: the request succeeds even if the queue push
    // fails (Redis down, process killed); the sweeper enqueues them later.
    // try/await (not .catch) also covers errors thrown synchronously.
    if (inserted.length > 0) {
      try {
        await this.queue.enqueue(inserted, requestId);
      } catch (err) {
        this.logger.error(`Enqueue failed for ${inserted.length} notifications, sweeper will retry: ${errorMessage(err)}`);
      }
    }

    // Respond in request order; duplicates resolve to the original rows.
    const byId = new Map(inserted.map((n) => [n.id, n]));
    const byKey = new Map(duplicates.map((n) => [n.idempotencyKey, n]));
    return rows.map((r) => {
      const created = byId.get(r.id);
      return { notification: this.toDto(created ?? byKey.get(r.idempotencyKey)!), replayed: !created };
    });
  }

  /**
   * Picks the idempotency key from the Idempotency-Key header and/or the body.
   * Both given and different is a client bug: rejected rather than guessed.
   */
  private resolveIdempotencyKey(headerKey: string | undefined, bodyKey: string | undefined): string | undefined {
    if (headerKey === undefined) return bodyKey;
    const key = headerKey.trim();
    if (!key || key.length > LIMITS.IDEMPOTENCY_KEY_MAX) {
      throw new AppException(ERROR.IDEMPOTENCY_KEY_INVALID);
    }
    if (bodyKey !== undefined && bodyKey !== key) {
      throw new AppException(ERROR.IDEMPOTENCY_KEY_MISMATCH);
    }
    return key;
  }

  /**
   * Checks that can't be expressed as DTO decorators: the template file
   * exists, placeholders compile, and scheduledAt is within the limit.
   */
  private validate(dto: SendNotificationDto) {
    if (dto.template && !this.templates.exists(dto.channel, dto.template)) {
      throw new AppException(ERROR.TEMPLATE_NOT_FOUND, undefined, {
        template: dto.template,
        channel: dto.channel,
      });
    }
    // Catch broken {{placeholders}} now rather than as a failed delivery.
    for (const text of [dto.subject, dto.body]) {
      if (!text) continue;
      try {
        this.templates.renderText(text, dto.data ?? {});
      } catch (err) {
        throw new AppException(ERROR.TEMPLATE_RENDER_FAILED, undefined, { reason: errorMessage(err) });
      }
    }
    if (dto.scheduledAt && new Date(dto.scheduledAt).getTime() > Date.now() + LIMITS.SCHEDULE_MAX_DAYS * DAY_MS) {
      throw new AppException(ERROR.VALIDATION_ERROR, {
        errors: [`scheduledAt must be within ${LIMITS.SCHEDULE_MAX_DAYS} days`],
      });
    }
  }

  /** Loads a notification of this tenant or throws NOTIFICATION_NOT_FOUND. */
  private async getOwned(tenantId: string, id: string): Promise<Notification> {
    const n = await this.notifications.findForTenant(tenantId, id);
    if (!n) throw new AppException(ERROR.NOTIFICATION_NOT_FOUND);
    return n;
  }

  /** Public shape: never exposes tenant internals. */
  private toDto(n: Notification): NotificationResponseDto {
    return {
      id: n.id,
      channel: n.channel,
      recipient: n.recipient,
      userId: n.userId,
      subject: n.subject,
      body: n.body,
      template: n.template,
      data: n.data,
      metadata: n.metadata,
      status: n.status,
      priority: n.priority,
      idempotencyKey: n.idempotencyKey,
      attempts: n.attempts,
      provider: n.provider,
      providerMessageId: n.providerMessageId,
      error: n.error,
      scheduledAt: n.scheduledAt,
      sentAt: n.sentAt,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    };
  }
}
