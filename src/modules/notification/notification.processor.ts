/**
 * BullMQ workers, one per channel queue.
 *
 * Registered with `autorun: false` and started by WorkerLifecycle once
 * ConfigService has the final configuration (after Secrets Manager): it
 * applies concurrency and the cross-worker rate limit from
 * <CHANNEL>_WORKER_CONCURRENCY / <CHANNEL>_RATE_MAX / <CHANNEL>_RATE_DURATION_MS,
 * and only starts them when APP_ROLE is `worker` or `all`.
 */

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WorkerConfig } from '../../config/configuration.js';
import { CHANNEL_QUEUE } from '../../constant/index.js';
import { ConnectionState } from '../../utils/connection-state.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import type { NotificationJob } from './notification.queue.js';

// Started explicitly by WorkerLifecycle, with settings from ConfigService.
const MANUAL_START = { autorun: false };

// @Injectable() makes TypeScript emit constructor metadata for the shared
// constructor; without it Nest can't inject the dispatcher into subclasses.
@Injectable()
abstract class ChannelProcessor extends WorkerHost {
  protected abstract readonly logger: Logger;

  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  /** Called by BullMQ for every job; delegates to the dispatcher. */
  process(job: Job<NotificationJob>, token?: string): Promise<void> {
    // The token lets the dispatcher re-delay the job when providers are at their limits.
    return this.dispatcher.dispatch(job, token);
  }

  // Created lazily: `logger` is a subclass field, set after this constructor.
  private connectionState?: ConnectionState;
  private get connection(): ConnectionState {
    return (this.connectionState ??= new ConnectionState(this.logger, `Worker "${this.worker.name}"`));
  }

  /** Applies concurrency and rate limit, then starts taking jobs. */
  start(settings: WorkerConfig): void {
    this.worker.concurrency = settings.concurrency;
    // Read by BullMQ on every job fetch, so setting it before run() applies it.
    this.worker.opts.limiter = { max: settings.rateMax, duration: settings.rateDurationMs };
    this.logger.log(
      `Worker started, consuming "${this.worker.name}" ` +
        `(concurrency ${settings.concurrency}, rate limit ${settings.rateMax} per ${settings.rateDurationMs}ms)`,
    );
    this.worker.run().catch((err: Error) => this.logger.error(`Worker stopped unexpectedly: ${err.message}`));
  }

  /** The worker's Redis connection is up again after an outage. */
  @OnWorkerEvent('ready')
  onReady() {
    this.connection.ready();
  }

  /** Graceful shutdown finished: no more jobs are taken. */
  @OnWorkerEvent('closed')
  onClosed() {
    this.logger.log(`Worker for "${this.worker.name}" stopped`);
  }

  // Connection problems etc.; without a listener they would crash the process.
  // One warning per outage, not one per reconnect attempt.
  @OnWorkerEvent('error')
  onError(err: Error) {
    this.connection.error(err);
  }

  // Delivery failures are logged by the dispatcher; this also surfaces
  // anything that failed outside it.
  @OnWorkerEvent('failed')
  onFailed(job: Job<NotificationJob> | undefined, err: Error) {
    this.logger.warn(`Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  }
}

/** Consumes the email queue. */
@Processor(CHANNEL_QUEUE.email, MANUAL_START)
export class EmailProcessor extends ChannelProcessor {
  protected readonly logger = new Logger(EmailProcessor.name);
}

/** Consumes the SMS queue. */
@Processor(CHANNEL_QUEUE.sms, MANUAL_START)
export class SmsProcessor extends ChannelProcessor {
  protected readonly logger = new Logger(SmsProcessor.name);
}

/** Consumes the push queue. */
@Processor(CHANNEL_QUEUE.push, MANUAL_START)
export class PushProcessor extends ChannelProcessor {
  protected readonly logger = new Logger(PushProcessor.name);
}

/** Consumes the in-app queue (inbox write + FCM signal). */
@Processor(CHANNEL_QUEUE.in_app, MANUAL_START)
export class InAppProcessor extends ChannelProcessor {
  protected readonly logger = new Logger(InAppProcessor.name);
}
