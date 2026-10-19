/**
 * Email through the SendGrid Web API.
 */

import { MailService } from '@sendgrid/mail';
import {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  PermanentDeliveryError,
} from '../../channel/channel.types.js';

/** SendGrid provider. */
export class SendgridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';
  // Own instance instead of the package singleton.
  private readonly client = new MailService();

  constructor(apiKey: string) {
    this.client.setApiKey(apiKey);
  }

  /** Startup log label. */
  describe(): string {
    return 'SendGrid Web API';
  }

  /** Sends one email; returns SendGrid's x-message-id. */
  async send(message: EmailMessage): Promise<DeliveryResult> {
    try {
      const [response] = await this.client.send({
        to: message.to,
        from: message.from,
        subject: message.subject,
        // SendGrid requires at least one content part.
        text: message.text ?? '',
        html: message.html,
      });
      const id = response.headers['x-message-id'];
      return { provider: this.name, providerMessageId: String(id ?? '') };
    } catch (err) {
      // 4xx (except 429 rate limit) means the request itself is invalid.
      const status = (err as { code?: number }).code ?? 0;
      if (status >= 400 && status < 500 && status !== 429) {
        throw new PermanentDeliveryError((err as Error).message, this.name);
      }
      throw err;
    }
  }
}
