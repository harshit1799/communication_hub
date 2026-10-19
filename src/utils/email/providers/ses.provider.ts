/**
 * Email through Amazon SES (API v2). Credentials come from the default AWS
 * provider chain (IAM role / IRSA) unless explicit keys are configured.
 */

import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { AwsConfig } from '../../../config/configuration.js';
import {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  PermanentDeliveryError,
} from '../../channel/channel.types.js';
import { awsClientConfig } from '../../aws.js';

// Errors where retrying the same request can't succeed.
const PERMANENT_ERRORS = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'BadRequestException',
  'NotFoundException',
]);

/** SES provider using the SendEmail (simple content) API. */
export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';
  private readonly client: SESv2Client;

  constructor(private readonly aws: AwsConfig) {
    this.client = new SESv2Client(awsClientConfig(aws));
  }

  /** Startup log label. */
  describe(): string {
    return `Amazon SES (${this.aws.region}, ${this.aws.accessKeyId ? 'static keys' : 'default credential chain'})`;
  }

  /** Sends one email; returns the SES MessageId. */
  async send(message: EmailMessage): Promise<DeliveryResult> {
    const charset = 'UTF-8';
    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: message.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: charset },
              Body: {
                Text: message.text ? { Data: message.text, Charset: charset } : undefined,
                Html: message.html ? { Data: message.html, Charset: charset } : undefined,
              },
            },
          },
        }),
      );
      return { provider: this.name, providerMessageId: result.MessageId ?? '' };
    } catch (err) {
      if (PERMANENT_ERRORS.has((err as Error).name)) {
        throw new PermanentDeliveryError((err as Error).message, this.name);
      }
      throw err;
    }
  }
}
