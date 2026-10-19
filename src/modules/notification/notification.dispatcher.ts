/**
 * Worker-side delivery of one notification:
 *
 *   1. claim it (queued/retrying -> processing, attempts + 1); skip if it
 *      was sent or cancelled meanwhile, which makes redelivery harmless
 *   2. render subject/body/template with tenant branding
 *   3. hand it to the channel's provider
 *   4. record the attempt and the outcome
 *
 * Errors: PermanentDeliveryError -> failed now (UnrecoverableError stops
 * BullMQ retries). Anything else -> retrying, rethrown so BullMQ retries
 * with exponential backoff; on the last attempt -> failed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, NotificationStatus } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { errorMessage, stringifyValues } from '../../utils/appUtils.js';
import { DeliveryResult, PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { EmailService } from '../../utils/email/email.service.js';
import { PushService } from '../../utils/firebase/push.service.js';
import { SmsService } from '../../utils/sms/sms.service.js';
import { TemplateData, TemplateService } from '../../utils/template/template.service.js';
import { DeviceRepository } from '../device/device.repository.js';
import { NotificationAttemptRepository } from './notification-attempt.repository.js';
import { NotificationRepository } from './notification.repository.js';
import type { NotificationJob } from './notification.queue.js';

/** Only instantiated in worker processes (see NotificationModule). */
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
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.appName = app.name;
    this.mailFrom = app.mail.from;
  }

  /**
   * Delivers the notification referenced by the job and records the
   * outcome. Throws to make BullMQ retry (or UnrecoverableError to stop).
   */
  async dispatch(job: Job<NotificationJob>): Promise<void> {
    const { notificationId, requestId } = job.data;
    const log = `notification=${notificationId}${requestId ? ` request=${requestId}` : ''}`;

    const attempt = await this.notifications.markProcessing(notificationId);
    if (attempt === null) {
      this.logger.debug(`Skipping ${log}: no longer deliverable`);
      return;
    }
    const notification = await this.notifications.findWithTenant(notificationId);
    if (!notification) return;

    const provider = this.providerName(notification.channel);
    const started = Date.now();
    let result: DeliveryResult;
    try {
      result = await this.deliver(notification);
    } catch (err) {
      const message = errorMessage(err);
      const permanent = err instanceof PermanentDeliveryError;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const status = permanent || lastAttempt ? NotificationStatus.Failed : NotificationStatus.Retrying;

      await this.attempts.record({
        notificationId,
        attempt,
        provider,
        success: false,
        error: message,
        permanent,
        durationMs: Date.now() - started,
      });
      await this.notifications.markFailure(notificationId, status, provider, message);
      if (err instanceof PermanentDeliveryError) {
        await this.devices.deactivate(notification.tenantId, err.invalidTokens);
      }
      this.logger.warn(`Attempt ${attempt} failed for ${log} via ${provider} -> ${status}: ${message}`);
      // Permanent: tell BullMQ not to retry. Transient: rethrow to retry.
      throw permanent ? new UnrecoverableError(message) : err;
    }

    // Delivered. Bookkeeping errors below are not delivery failures; if one
    // throws, BullMQ retries the job, so delivery is at-least-once.
    await this.attempts.record({
      notificationId,
      attempt,
      provider: result.provider,
      success: true,
      providerMessageId: result.providerMessageId,
      durationMs: Date.now() - started,
    });
    await this.notifications.markSent(notificationId, result.provider, result.providerMessageId);
    await this.devices.deactivate(notification.tenantId, result.invalidTokens ?? []);
    this.logger.log(`Sent ${log} via ${result.provider} (attempt ${attempt})`);
  }

  /**
   * Renders the message for its channel and sends it through the
   * channel's provider. Push-to-user resolves the user's active tokens.
   */
  private async deliver(n: Notification): Promise<DeliveryResult> {
    const settings = n.tenant?.settings ?? {};
    const data: TemplateData = {
      appName: settings.appName ?? this.appName,
      year: new Date().getFullYear(),
      ...n.data,
    };
    const subject = n.subject ? this.render(() => this.templates.renderText(n.subject!, data)) : undefined;
    const text = n.body ? this.render(() => this.templates.renderText(n.body!, data)) : undefined;
    const fromTemplate = () =>
      n.template
        ? this.render(() => this.templates.render(n.channel, n.template!, { ...data, subject }))
        : undefined;

    switch (n.channel) {
      case NotificationChannel.Email:
        return this.email.send({
          to: n.recipient!,
          from: settings.emailFrom ?? this.mailFrom,
          subject: subject!,
          text,
          html: fromTemplate(),
        });

      case NotificationChannel.Sms:
        return this.sms.send({ to: n.recipient!, body: fromTemplate() ?? text!, from: settings.smsFrom });

      case NotificationChannel.Push: {
        const tokens = n.recipient ? [n.recipient] : await this.devices.activeTokens(n.tenantId, n.userId!);
        if (tokens.length === 0) {
          throw new PermanentDeliveryError(`No active devices registered for user ${n.userId}`, this.push.providerName);
        }
        return this.push.send({
          tokens,
          title: subject,
          body: fromTemplate() ?? text!,
          // Lets the app correlate the push with this notification.
          data: stringifyValues({ ...n.metadata, notificationId: n.id }),
        });
      }
    }
  }

  /** A template that can't render will never render: fail permanently. */
  private render(fn: () => string): string {
    try {
      return fn();
    } catch (err) {
      throw new PermanentDeliveryError(`Template rendering failed: ${errorMessage(err)}`, 'template');
    }
  }

  /** Name of the provider configured for a channel (for attempt records). */
  private providerName(channel: NotificationChannel): string {
    return {
      [NotificationChannel.Email]: this.email,
      [NotificationChannel.Sms]: this.sms,
      [NotificationChannel.Push]: this.push,
    }[channel].providerName;
  }
}
