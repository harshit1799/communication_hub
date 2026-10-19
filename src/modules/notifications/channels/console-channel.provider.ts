/**
 * Development provider that logs messages to the console instead of really
 * sending them. Lets the service run without any vendor credentials.
 */

// Logger: Nest's built-in logger.
import { Logger } from '@nestjs/common';
// randomUUID: generates a fake provider message id.
import { randomUUID } from 'node:crypto';
// Channel enum.
import { NotificationChannel } from '../enums/notification-channel.enum.js';
// The provider contract this class implements.
import {
  ChannelProvider,
  ChannelSendResult,
  OutgoingMessage,
} from './channel-provider.interface.js';

export class ConsoleChannelProvider implements ChannelProvider {
  // Logger whose context shows the channel name, e.g. "ConsoleChannel:sms".
  private readonly logger: Logger;

  // `readonly channel` is a parameter property: it declares and assigns
  // the `channel` field in one step.
  constructor(readonly channel: NotificationChannel) {
    this.logger = new Logger(`ConsoleChannel:${channel}`);
  }

  /** "Sends" the message by printing it. */
  send(message: OutgoingMessage): Promise<ChannelSendResult> {
    // Print the text, or note the HTML size for templated emails.
    const content =
      message.text ?? `[html, ${message.html?.length ?? 0} chars]`;
    this.logger.log(
      `[tenant=${message.tenantId}] -> ${message.recipient}: ` +
        `${message.subject ? `${message.subject} | ` : ''}${content}`,
    );
    // Resolve immediately with a fake message id prefixed with "console-".
    return Promise.resolve({ providerMessageId: `console-${randomUUID()}` });
  }
}
