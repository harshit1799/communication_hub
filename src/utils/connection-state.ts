/**
 * Turns a stream of connection events into readable logs: the first error
 * of an outage is a warning, repeats while it lasts go to debug, and the
 * recovery is logged once. Keeps a Redis outage from flooding the logs with
 * one identical error per reconnect attempt.
 */

import { Logger } from '@nestjs/common';

export class ConnectionState {
  private down = false;

  constructor(
    private readonly logger: Logger,
    // What is connected, for the messages, e.g. 'queue "notifications-sms"'.
    private readonly what: string,
  ) {}

  /** Call on every error event. Only the first one of an outage is a warning. */
  error(err: Error): void {
    if (this.down) {
      this.logger.debug(`${this.what} still unreachable: ${err.message}`);
      return;
    }
    this.down = true;
    this.logger.warn(`${this.what} connection error: ${err.message}. Retrying in the background.`);
  }

  /** Call when the connection is (re)established. Logs only a recovery. */
  ready(): void {
    if (!this.down) return;
    this.down = false;
    this.logger.log(`${this.what} reconnected`);
  }
}
