/**
 * API-side notification logic: validate, persist, enqueue. Delivery itself
 * happens asynchronously in the workers (notification.dispatcher.ts), so the
 * API stays fast and vendor outages never block clients.
 *
 * At accept time the template is resolved and its version pinned;
 * recipient and data are encrypted on insert
 * (column transformers) with a blind index for lookups.
 *
 * Reliability: the row is committed before the job is enqueued. If
 * enqueueing fails the request still succeeds (the notification is durably
 * accepted) and the maintenance sweeper enqueues it shortly after.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { randomUUID } from 'node:crypto';
import { Cursor } from '../../common/dtos/common.dtos.js';
import { LIMITS, NotificationChannel, NotificationPriority, NotificationStatus } from '../../constant/index.js';
import { ListNotificationsDto, SendNotificationDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { Notification, NotificationAttempt } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { errorMessage } from '../../utils/appUtils.js';
import { FieldCipher } from '../../utils/crypto/field-cipher.js';
import { normaliseRecipient } from '../../utils/crypto/recipient.js';
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { selectFrom } from '../provider/from-addresses.js';
import { ProviderResolver } from '../provider/provider.resolver.js';
import { TemplateService } from '../template/template.service.js';
import { NotificationQueue, QueueSnapshot } from './notification.queue.js';
import { RetryPolicyService } from './retry-policy.service.js';
import { NewNotification, NotificationRepository } from './notification.repository.js';

/** One day in milliseconds (scheduling limit). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Result of one accepted notification. */
export interface SendResult {
  notification: Notification;
  // True when an earlier notification was returned for a repeated idempotency key.
  replayed: boolean;
  // Attempts so far: [] for a new notification, the history for a replay.
  attempts: NotificationAttempt[];
  // Live queue state; null when Redis can't be read right now.
  queue: QueueSnapshot | null;
}

/** Used by NotificationController; never talks to vendors directly. */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly queue: NotificationQueue,
    private readonly templates: TemplateService,
    private readonly providers: ProviderResolver,
    private readonly cipher: FieldCipher,
    private readonly metrics: MetricsService,
    private readonly retryPolicies: RetryPolicyService,
    config: ConfigService,
  ) {
    this.maxAttempts = config.getOrThrow<AppConfig>('app').queue.attempts;
  }

  private readonly maxAttempts: number;

  /** Accepts one notification (normal priority unless set). */
  async send(tenantId: string, dto: SendNotificationDto, requestId?: string): Promise<SendResult> {
    // Single sends default to normal priority: ahead of bulk (low) campaigns.
    const [result] = await this.sendMany(tenantId, [dto], NotificationPriority.Normal, requestId);
    return result;
  }

  /** Accepts many notifications in one insert and one enqueue per channel. */
  async sendBulk(tenantId: string, dtos: SendNotificationDto[], requestId?: string): Promise<SendResult[]> {
    // Bulk sends (campaigns) default to low priority, so single sends such as
    // login OTPs are delivered first even while a large campaign is queued.
    return this.sendMany(tenantId, dtos, NotificationPriority.Low, requestId);
  }

  /** One page of the tenant's notifications. Throws INVALID_ARGUMENT on a bad cursor. */
  list(tenantId: string, query: ListNotificationsDto) {
    if (query.cursor && !Cursor.decode(query.cursor)) {
      throw new AppException(ERROR.VALIDATION_ERROR, { errors: ['cursor is invalid'] }, { detail: 'cursor is invalid' });
    }
    return this.notifications.list(tenantId, {
      status: query.status,
      channel: query.channel,
      userId: query.userId,
      limit: query.limit,
      cursor: query.cursor,
      // Recipients are encrypted: match on the blind index. Without a channel
      // the email normalisation (lower-case) is applied when it looks like one.
      recipientHash: query.recipient
        ? this.recipientHash(tenantId, query.channel ?? (query.recipient.includes('@') ? 'email' : 'sms'), query.recipient)
        : undefined,
    });
  }

  /** A notification with its attempt log. Throws NOTIFICATION_NOT_FOUND. */
  /** A notification with its attempt log and live queue state. Throws NOTIFICATION_NOT_FOUND. */
  async findOne(tenantId: string, id: string): Promise<{ notification: Notification; queue: QueueSnapshot | null }> {
    const n = await this.notifications.findWithAttempts(tenantId, id);
    if (!n) throw new AppException(ERROR.NOTIFICATION_NOT_FOUND);
    return { notification: n, queue: await this.queueState(n) };
  }

  /** Sends a failed notification again (e.g. after fixing a provider). */
  async retry(tenantId: string, id: string, requestId?: string): Promise<Notification> {
    const n = await this.getOwned(tenantId, id);
    if (!(await this.notifications.requeueFailed(n.id))) {
      throw new AppException(ERROR.NOTIFICATION_NOT_RETRYABLE);
    }
    // try/await (not .catch): also covers errors thrown synchronously.
    try {
      await this.queue.ensureEnqueued(n, requestId, await this.retryPolicies.forNotification(n));
    } catch (err) {
      this.logger.error(`Enqueue failed for ${n.id}, sweeper will retry: ${errorMessage(err)}`);
    }
    return { ...n, status: NotificationStatus.Queued, error: null };
  }

  /** Cancels a notification that hasn't been delivered yet. */
  async cancel(tenantId: string, id: string): Promise<Notification> {
    const n = await this.getOwned(tenantId, id);
    // The status flip is what matters: workers skip cancelled rows even if
    // the job is still in Redis. Removing the job just frees the slot early.
    if (!(await this.notifications.cancel(n.id))) {
      throw new AppException(ERROR.NOTIFICATION_NOT_CANCELLABLE);
    }
    await this.queue.remove(n).catch(() => undefined);
    return { ...n, status: NotificationStatus.Cancelled };
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
  ): Promise<SendResult[]> {
    // Reject bad input before anything is stored (all or nothing).
    const resolved = await this.validate(tenantId, dtos);

    const rows: NewNotification[] = dtos.map((dto, i) => ({
      id: randomUUID(),
      tenantId,
      channel: dto.channel,
      recipient: dto.recipient ?? null,
      recipientHash: dto.recipient ? this.recipientHash(tenantId, dto.channel, dto.recipient) : null,
      userId: dto.userId ?? null,
      subject: dto.subject ?? null,
      body: dto.body ?? null,
      template: dto.template ?? null,
      templateId: resolved[i]?.templateId ?? null,
      templateVersion: resolved[i]?.version ?? null,
      data: dto.data ?? null,
      metadata: dto.metadata ?? null,
      fromAddress: dto.from?.trim() ?? null,
      alsoPush: dto.alsoPush ?? false,
      status: NotificationStatus.Queued,
      priority: dto.priority ?? defaultPriority,
      idempotencyKey: dto.idempotencyKey ?? null,
      scheduledAt: dto.scheduledAt ?? null,
    }));

    const { inserted, duplicates } = await this.notifications.insertIdempotent(tenantId, rows);
    // The rows are committed: the request succeeds even if the queue push
    // fails (Redis down, process killed); the sweeper enqueues them later.
    // try/await (not .catch) also covers errors thrown synchronously.
    if (inserted.length > 0) {
      try {
        const policies = await this.retryPolicies.forMany(inserted);
        await this.queue.enqueue(inserted, requestId, (n) => policies.get(n as Notification));
      } catch (err) {
        this.logger.error(`Enqueue failed for ${inserted.length} notifications, sweeper will retry: ${errorMessage(err)}`);
      }
    }

    // Respond in request order; duplicates resolve to the original rows.
    const byId = new Map(inserted.map((n) => [n.id, n]));
    const byKey = new Map(duplicates.map((n) => [n.idempotencyKey, n]));
    const results = rows.map((r) => {
      const created = byId.get(r.id);
      if (created) this.metrics.accepted.inc({ channel: r.channel, priority: r.priority });
      else this.metrics.replayed.inc({ channel: r.channel });
      return { notification: created ?? byKey.get(r.idempotencyKey)!, replayed: !created };
    });

    // Queue state for each, and the attempt history for replays (a retrying
    // client sees what already happened). Read after enqueueing, so a fast
    // worker may already show the job as active or completed.
    return Promise.all(
      results.map(async (r) => ({
        ...r,
        queue: await this.queueState(r.notification),
        attempts: r.replayed ? ((await this.notifications.findWithAttempts(tenantId, r.notification.id))?.attemptLog ?? []) : [],
      })),
    );
  }

  /** Live queue state, or null when Redis can't be read (never fails the request). */
  private async queueState(n: Notification): Promise<QueueSnapshot | null> {
    try {
      return await this.queue.inspect(n, this.maxAttempts);
    } catch (err) {
      this.logger.warn(`Queue state unavailable for ${n.id}: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Checks DTO decorators can't express: the template exists (and pins its
   * version), the From name exists on a provider, inline placeholders
   * compile, scheduledAt is within the limit. Template lookups are shared
   * across a bulk request.
   */
  private async validate(tenantId: string, dtos: SendNotificationDto[]): Promise<({ templateId: string; version: number } | null)[]> {
    const templateLookups = new Map<string, Promise<{ templateId: string; version: number }>>();
    const fromLookups = new Map<string, Promise<string | null>>();
    const resolved: ({ templateId: string; version: number } | null)[] = [];

    for (const dto of dtos) {
      for (const text of [dto.subject, dto.body]) {
        if (!text) continue;
        try {
          this.templates.renderText(text, dto.data ?? {});
        } catch (err) {
          throw new AppException(ERROR.TEMPLATE_RENDER_FAILED, undefined, { reason: errorMessage(err) });
        }
      }
      if (dto.from) {
        // Same selection as the worker: an unknown From name fails now, not at delivery.
        const key = `${dto.channel}:${dto.from}`;
        if (!fromLookups.has(key)) {
          fromLookups.set(
            key,
            this.providers.resolve(tenantId, dto.channel).then((handles) => {
              const selection = selectFrom(dto.channel, handles, dto.from, '');
              return selection.ok ? null : selection.error;
            }),
          );
        }
        const error = await fromLookups.get(key);
        if (error) throw new AppException(ERROR.FROM_NOT_FOUND, { errors: [error] }, { from: dto.from });
      }
      if (dto.alsoPush && dto.channel !== NotificationChannel.InApp) {
        const message = 'alsoPush is only supported for CHANNEL_IN_APP';
        throw new AppException(ERROR.VALIDATION_ERROR, { errors: [message] }, { detail: message });
      }
      if (dto.scheduledAt && dto.scheduledAt.getTime() > Date.now() + LIMITS.SCHEDULE_MAX_DAYS * DAY_MS) {
        const message = `scheduledAt must be within ${LIMITS.SCHEDULE_MAX_DAYS} days`;
        throw new AppException(ERROR.VALIDATION_ERROR, { errors: [message] }, { detail: message });
      }
      if (dto.template) {
        const key = `${dto.channel}:${dto.template}:${dto.templateVersion ?? ''}`;
        if (!templateLookups.has(key)) {
          templateLookups.set(key, this.templates.resolveForSend(tenantId, dto.channel, dto.template, dto.templateVersion));
        }
        resolved.push(await templateLookups.get(key)!);
      } else {
        resolved.push(null);
      }
    }
    return resolved;
  }

  /** Blind index of a recipient, as stored in notifications.recipient_hash. */
  private recipientHash(tenantId: string, channel: string, recipient: string): string {
    return this.cipher.blindIndex(tenantId, normaliseRecipient(channel, recipient));
  }

  /** Loads a notification of this tenant or throws NOTIFICATION_NOT_FOUND. */
  private async getOwned(tenantId: string, id: string): Promise<Notification> {
    const n = await this.notifications.findForTenant(tenantId, id);
    if (!n) throw new AppException(ERROR.NOTIFICATION_NOT_FOUND);
    return n;
  }
}
