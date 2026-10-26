/**
 * Worker-side delivery of one notification:
 *
 *   1. claim it (queued/retrying -> processing, attempts + 1); skip if it
 *      was sent or cancelled meanwhile, which makes redelivery harmless
 *   2. render the pinned template version / inline text with tenant branding
 *   3. pick the sender (request > rule > tenant default, SenderResolver)
 *   4. get the tenant's providers in failover order (ProviderResolver:
 *      Redis cache -> Postgres -> platform default) and try them in turn
 *   5. record every provider call and the outcome
 *
 * Errors: PermanentDeliveryError -> failed now (UnrecoverableError stops
 * BullMQ retries; no failover: another vendor would reject it too). Any
 * other error -> next provider; when all failed -> retrying, rethrown so
 * BullMQ retries with exponential backoff; on the last attempt -> failed.
 *
 * In-app (CHANNEL_IN_APP): step 4-5 become "write the inbox row" (the
 * delivery, idempotent per notification), then a best-effort FCM signal to
 * the user's devices through the push providers: silent data message, or a
 * visible push with alsoPush. A failed signal never fails the delivery:
 * the message is in the inbox and the app sees it on its next sync.
 *
 * Every outcome is one structured log line (event=delivery_*), shipped to
 * Loki, plus Prometheus counters (see MetricsService).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, NotificationStatus } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { errorMessage, stringifyValues } from '../../utils/appUtils.js';
import {
  DeliveryResult,
  EmailProvider,
  PermanentDeliveryError,
  PushProvider,
  SmsProvider,
} from '../../utils/channel/channel.types.js';
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { RequestContextStore } from '../../utils/request-context.js';
import { RenderedContent, TemplateData } from '../../utils/template/template-renderer.js';
import { DeviceRepository } from '../device/device.repository.js';
import { InboxService } from '../inbox/inbox.service.js';
import { ProviderResolver } from '../provider/provider.resolver.js';
import type { ProviderHandle } from '../provider/provider.types.js';
import { ResolvedSender, SenderResolver } from '../sender/sender.resolver.js';
import { TemplateService } from '../template/template.service.js';
import { NotificationAttemptRepository } from './notification-attempt.repository.js';
import { NotificationRepository } from './notification.repository.js';
import type { NotificationJob } from './notification.queue.js';

/** Everything prepared before the first provider call. */
interface Prepared {
  content: RenderedContent;
  sender: ResolvedSender | null;
  providers: ProviderHandle[];
}

/** Only consumes jobs in worker processes (see WorkerLifecycle). */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly appName: string;
  private readonly mailFrom: string;

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly attempts: NotificationAttemptRepository,
    private readonly devices: DeviceRepository,
    private readonly templates: TemplateService,
    private readonly senders: SenderResolver,
    private readonly providers: ProviderResolver,
    private readonly metrics: MetricsService,
    private readonly inbox: InboxService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.appName = app.name;
    this.mailFrom = app.mail.from;
  }

  /**
   * Delivers the notification referenced by the job and records the
   * outcome. Throws to make BullMQ retry (or UnrecoverableError to stop).
   * Runs in a request context carrying the API request id, so worker logs
   * correlate with the gRPC call that accepted the notification.
   */
  dispatch(job: Job<NotificationJob>): Promise<void> {
    const { notificationId, requestId } = job.data;
    return RequestContextStore.run({ requestId: requestId ?? `job-${job.id}` }, () => this.deliverJob(job, notificationId));
  }

  private async deliverJob(job: Job<NotificationJob>, notificationId: string): Promise<void> {
    const attempt = await this.notifications.markProcessing(notificationId);
    if (attempt === null) {
      this.logger.debug({ msg: 'Skipping: no longer deliverable', event: 'delivery_skipped', notificationId });
      return;
    }
    const n = await this.notifications.findWithTenant(notificationId);
    if (!n) return;
    RequestContextStore.assign({ tenantId: n.tenantId });
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const base = { notificationId: n.id, tenantId: n.tenantId, channel: n.channel, attempt };

    // Rendering, sender and provider lookup. Failing here counts as an
    // attempt without a provider call ("template", "sender", ...).
    let prepared: Prepared;
    try {
      prepared = await this.prepare(n);
    } catch (err) {
      const provider = err instanceof PermanentDeliveryError ? err.provider : this.providers.platformName(n.channel);
      await this.fail(n, attempt, provider, null, err, 0, lastAttempt, base);
      throw err instanceof PermanentDeliveryError ? new UnrecoverableError(errorMessage(err)) : err;
    }

    if (n.channel === NotificationChannel.InApp) return this.deliverInApp(n, attempt, prepared, lastAttempt, base);

    const { providers, sender } = prepared;
    for (const [index, handle] of providers.entries()) {
      const provider = handle.spec.provider;
      const started = Date.now();
      let result: DeliveryResult;
      try {
        result = await this.send(n, handle, prepared);
      } catch (err) {
        const durationMs = Date.now() - started;
        this.metrics.deliveryDuration.observe({ channel: n.channel, provider }, durationMs / 1000);
        const isLast = index === providers.length - 1;
        if (err instanceof PermanentDeliveryError || isLast) {
          await this.fail(n, attempt, provider, sender, err, durationMs, lastAttempt, { ...base, providerConfigId: handle.spec.id });
          if (err instanceof PermanentDeliveryError) {
            await this.devices.deactivate(n.tenantId, err.invalidTokens);
            throw new UnrecoverableError(errorMessage(err));
          }
          throw err;
        }
        // Transient: hand over to the next provider within this attempt.
        await this.recordAttempt(n.id, attempt, provider, sender, false, null, errorMessage(err), false, durationMs);
        this.metrics.attempts.inc({ channel: n.channel, provider, outcome: 'transient_error' });
        this.metrics.failovers.inc({ channel: n.channel, from_provider: provider });
        this.logger.warn({
          msg: `Provider ${provider} failed, failing over to ${providers[index + 1].spec.provider}`,
          event: 'provider_failover',
          ...base,
          provider,
          providerConfigId: handle.spec.id,
          nextProvider: providers[index + 1].spec.provider,
          error: errorMessage(err),
          durationMs,
        });
        continue;
      }

      // Delivered. Bookkeeping errors below are not delivery failures; if one
      // throws, BullMQ retries the job, so delivery is at-least-once.
      const durationMs = Date.now() - started;
      this.metrics.deliveryDuration.observe({ channel: n.channel, provider }, durationMs / 1000);
      this.metrics.attempts.inc({ channel: n.channel, provider, outcome: 'success' });
      await this.recordAttempt(n.id, attempt, result.provider, sender, true, result.providerMessageId, null, false, durationMs);
      await this.notifications.markSent(n.id, result.provider, result.providerMessageId);
      await this.devices.deactivate(n.tenantId, result.invalidTokens ?? []);
      this.metrics.finished.inc({ channel: n.channel, status: NotificationStatus.Sent });
      this.logger.log({
        msg: `Sent via ${result.provider} (attempt ${attempt})`,
        event: 'delivery_sent',
        ...base,
        provider: result.provider,
        providerConfigId: handle.spec.id,
        providerMessageId: result.providerMessageId,
        senderSource: sender?.source,
        durationMs,
      });
      return;
    }
  }

  /**
   * In-app: the inbox write is the delivery (retried like any send); the
   * FCM signal afterwards is best effort with failover across push providers.
   */
  private async deliverInApp(
    n: Notification,
    attempt: number,
    { content, providers }: Prepared,
    lastAttempt: boolean,
    base: Record<string, unknown>,
  ): Promise<void> {
    const started = Date.now();
    let message;
    try {
      message = await this.inbox.deliver(n, { title: content.subject, body: content.body });
    } catch (err) {
      await this.fail(n, attempt, 'inbox', null, err, Date.now() - started, lastAttempt, base);
      throw err;
    }
    const durationMs = Date.now() - started;
    this.metrics.deliveryDuration.observe({ channel: n.channel, provider: 'inbox' }, durationMs / 1000);
    this.metrics.attempts.inc({ channel: n.channel, provider: 'inbox', outcome: 'success' });
    await this.recordAttempt(n.id, attempt, 'inbox', null, true, message.id, null, false, durationMs);
    await this.notifications.markSent(n.id, 'inbox', message.id);
    this.metrics.finished.inc({ channel: n.channel, status: NotificationStatus.Sent });
    this.logger.log({ msg: `Stored in inbox (attempt ${attempt})`, event: 'delivery_sent', ...base, provider: 'inbox', inboxMessageId: message.id, durationMs });

    await this.signalDevices(n, message.id, content, providers, base);
  }

  /** Silent (or, with alsoPush, visible) FCM message to the user's active devices. */
  private async signalDevices(
    n: Notification,
    inboxMessageId: string,
    content: RenderedContent,
    providers: ProviderHandle[],
    base: Record<string, unknown>,
  ): Promise<void> {
    try {
      const tokens = await this.devices.activeTokens(n.tenantId, n.userId!);
      if (tokens.length === 0) {
        this.metrics.inboxSignals.inc({ outcome: 'no_devices' });
        return;
      }
      const unreadCount = await this.inbox.unreadCount(n.tenantId, n.userId!);
      const data = stringifyValues({ ...n.metadata, type: 'inbox', inboxMessageId, notificationId: n.id, unreadCount: String(unreadCount) });
      for (const [index, handle] of providers.entries()) {
        try {
          const client = (await handle.client()) as PushProvider;
          const result = await client.send({ tokens, title: content.subject, body: content.body ?? '', data, silent: !n.alsoPush });
          await this.devices.deactivate(n.tenantId, result.invalidTokens ?? []);
          this.metrics.inboxSignals.inc({ outcome: n.alsoPush ? 'visible' : 'silent' });
          return;
        } catch (err) {
          if (err instanceof PermanentDeliveryError) await this.devices.deactivate(n.tenantId, err.invalidTokens);
          if (err instanceof PermanentDeliveryError || index === providers.length - 1) throw err;
        }
      }
    } catch (err) {
      this.metrics.inboxSignals.inc({ outcome: 'failed' });
      this.logger.warn({ msg: `Inbox signal failed: ${errorMessage(err)}`, event: 'inbox_signal_failed', ...base, error: errorMessage(err) });
    }
  }

  /** Renders content and resolves sender + providers. */
  private async prepare(n: Notification): Promise<Prepared> {
    const content = await this.render(n);
    const sender = await this.senders.resolve({
      tenantId: n.tenantId,
      channel: n.channel,
      senderId: n.senderId,
      templateId: n.templateId,
      recipient: n.recipient,
    });
    const providers = await this.providers.resolve(n.tenantId, n.channel, sender?.providerConfigId);
    return { content, sender, providers };
  }

  /**
   * Content for the channel: the pinned template version, with an inline
   * subject overriding the template's; inline body when there is no template.
   */
  private async render(n: Notification): Promise<RenderedContent> {
    const data: TemplateData = {
      appName: n.tenant?.settings?.appName ?? this.appName,
      year: new Date().getFullYear(),
      ...n.data,
    };
    const inline = (text: string | null) => {
      if (!text) return undefined;
      try {
        return this.templates.renderText(text, data);
      } catch (err) {
        throw new PermanentDeliveryError(`Template rendering failed: ${errorMessage(err)}`, 'template');
      }
    };
    const subject = inline(n.subject);
    const body = inline(n.body);
    if (n.template && !(n.templateId && n.templateVersion)) {
      throw new PermanentDeliveryError(`Template "${n.template}" was deleted`, 'template');
    }
    if (!n.templateId || !n.templateVersion) return { subject, body };
    const rendered = await this.templates.render(n.templateId, n.templateVersion, data, subject);
    return {
      subject: rendered.subject,
      // Email: an inline body is the text part next to the template HTML.
      body: n.channel === NotificationChannel.Email ? (body ?? rendered.body) : (rendered.body ?? body),
      html: rendered.html,
    };
  }

  /** One provider call for the notification's channel. */
  private async send(n: Notification, handle: ProviderHandle, { content, sender }: Prepared): Promise<DeliveryResult> {
    const client = await handle.client();
    switch (n.channel) {
      case NotificationChannel.Email:
        return (client as EmailProvider).send({
          to: n.recipient!,
          from: sender?.value ?? this.mailFrom,
          subject: content.subject ?? '',
          text: content.body,
          html: content.html,
        });

      case NotificationChannel.Sms:
        return (client as SmsProvider).send({ to: n.recipient!, body: content.body ?? '', from: sender?.value });

      case NotificationChannel.InApp:
        throw new Error('in-app notifications are delivered by deliverInApp');

      case NotificationChannel.Push: {
        const tokens = n.recipient ? [n.recipient] : await this.devices.activeTokens(n.tenantId, n.userId!);
        if (tokens.length === 0) {
          throw new PermanentDeliveryError(`No active devices registered for user ${n.userId}`, client.name);
        }
        return (client as PushProvider).send({
          tokens,
          title: content.subject,
          body: content.body ?? '',
          // Lets the app correlate the push with this notification.
          data: stringifyValues({ ...n.metadata, notificationId: n.id }),
        });
      }
    }
  }

  /** Records a failed attempt and moves the notification to retrying/failed. */
  private async fail(
    n: Notification,
    attempt: number,
    provider: string,
    sender: ResolvedSender | null,
    err: unknown,
    durationMs: number,
    lastAttempt: boolean,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const message = errorMessage(err);
    const permanent = err instanceof PermanentDeliveryError;
    const status = permanent || lastAttempt ? NotificationStatus.Failed : NotificationStatus.Retrying;
    await this.recordAttempt(n.id, attempt, provider, sender, false, null, message, permanent, durationMs);
    await this.notifications.markFailure(n.id, status, provider, message);
    this.metrics.attempts.inc({ channel: n.channel, provider, outcome: permanent ? 'permanent_error' : 'transient_error' });
    if (status === NotificationStatus.Failed) this.metrics.finished.inc({ channel: n.channel, status });
    else this.metrics.retries.inc({ channel: n.channel });
    this.logger.warn({
      msg: `Attempt ${attempt} failed via ${provider} -> ${status}: ${message}`,
      event: status === NotificationStatus.Failed ? 'delivery_failed' : 'delivery_retry',
      ...fields,
      provider,
      status,
      permanent,
      error: message,
      durationMs,
    });
  }

  private recordAttempt(
    notificationId: string,
    attempt: number,
    provider: string,
    sender: ResolvedSender | null,
    success: boolean,
    providerMessageId: string | null,
    error: string | null,
    permanent: boolean,
    durationMs: number,
  ): Promise<void> {
    return this.attempts.record({
      notificationId,
      attempt,
      provider,
      sender: sender?.value ?? null,
      success,
      providerMessageId,
      error,
      permanent,
      durationMs,
    });
  }
}
