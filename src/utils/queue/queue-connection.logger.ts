/**
 * Logs the BullMQ queue connections: one line once every queue's Redis
 * connection is ready, then one warning per outage and one line per
 * recovery (see ConnectionState). Workers log their own start, see the
 * processors.
 *
 * Error listeners are attached in the constructor, i.e. as soon as the
 * queues exist. A queue whose first connection attempt fails before a
 * listener is attached makes BullMQ print the raw error with console.error.
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppConfig } from '../../config/configuration.js';
import { CHANNEL_QUEUE, MAINTENANCE_QUEUE } from '../../constant/index.js';
import { errorMessage } from '../appUtils.js';
import { ConnectionState } from '../connection-state.js';

// How long to wait for the first connection before logging a warning.
const CONNECT_WARN_AFTER_MS = 10_000;

@Injectable()
export class QueueConnectionLogger implements OnApplicationBootstrap {
  private readonly logger = new Logger('BullMQ');
  private readonly target: string;
  private readonly queues: Queue[];

  constructor(
    @InjectQueue(CHANNEL_QUEUE.email) email: Queue,
    @InjectQueue(CHANNEL_QUEUE.sms) sms: Queue,
    @InjectQueue(CHANNEL_QUEUE.push) push: Queue,
    @InjectQueue(CHANNEL_QUEUE.in_app) inApp: Queue,
    @InjectQueue(MAINTENANCE_QUEUE) maintenance: Queue,
    config: ConfigService,
  ) {
    const { redis } = config.getOrThrow<AppConfig>('app');
    this.target = `${redis.host}:${redis.port}${redis.cluster ? ' (cluster)' : `/${redis.db}`}`;
    this.queues = [email, sms, push, inApp, maintenance];
    for (const queue of this.queues) {
      const state = new ConnectionState(this.logger, `Queue "${queue.name}"`);
      queue.on('error', (err) => state.error(err));
      // The backend emits 'ready' again after reconnecting.
      queue.backend.on('ready', () => state.ready());
    }
  }

  /**
   * Logs once all queues are connected. Not awaited: with Redis down this
   * would hold up startup, and BullMQ reconnects on its own.
   */
  onApplicationBootstrap() {
    const names = this.queues.map((q) => q.name).join(', ');
    const warn = setTimeout(
      () => this.logger.warn(`Queues not connected to ${this.target} yet; retrying in the background`),
      CONNECT_WARN_AFTER_MS,
    ).unref();
    Promise.all(this.queues.map((q) => q.waitUntilReady())).then(
      () => {
        clearTimeout(warn);
        this.logger.log(`Connected to ${this.target}; queues: ${names}`);
      },
      (err: unknown) => this.logger.error(`Queues failed to connect to ${this.target}: ${errorMessage(err)}`),
    );
  }
}
