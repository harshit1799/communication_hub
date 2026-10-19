/**
 * Development provider for every channel: logs the message instead of
 * sending it, so the service runs end-to-end without vendor credentials.
 */

import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  PushMessage,
  PushProvider,
  SmsMessage,
  SmsProvider,
} from './channel.types.js';

/** One class serves all three channels, since it only logs. */
export class ConsoleProvider implements EmailProvider, SmsProvider, PushProvider {
  readonly name = 'console';
  private readonly logger: Logger;

  constructor(channel: string) {
    this.logger = new Logger(`ConsoleProvider:${channel}`);
  }

  /** Startup log label. */
  describe(): string {
    return 'console (log only, nothing is delivered)';
  }

  /** Logs the message and returns a fake "console-<uuid>" message id. */
  send(message: EmailMessage | SmsMessage | PushMessage): Promise<DeliveryResult> {
    const target = 'tokens' in message ? message.tokens.join(',') : message.to;
    const content =
      'subject' in message
        ? `${message.subject} | ${message.text ?? `[html ${message.html?.length ?? 0} chars]`}`
        : 'title' in message && message.title
          ? `${message.title} | ${message.body}`
          : message.body;
    this.logger.log(`-> ${target}: ${content}`);
    return Promise.resolve({ provider: this.name, providerMessageId: `console-${randomUUID()}` });
  }
}
