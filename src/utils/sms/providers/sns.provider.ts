/**
 * SMS through Amazon SNS (direct publish to a phone number).
 */

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { AwsConfig } from '../../../config/configuration.js';
import {
  DeliveryResult,
  PermanentDeliveryError,
  SmsMessage,
  SmsProvider,
} from '../../channel/channel.types.js';
import { awsClientConfig } from '../../aws.js';

/** SNS errors where retrying the same request can't succeed. */
const PERMANENT_ERRORS = new Set([
  'InvalidParameterException',
  'InvalidParameterValueException',
  'OptedOutException',
]);

/** SNS provider; messages are sent as Transactional. */
export class SnsSmsProvider implements SmsProvider {
  readonly name = 'sns';
  private readonly client: SNSClient;

  constructor(
    private readonly aws: AwsConfig,
    private readonly senderId?: string,
  ) {
    this.client = new SNSClient(awsClientConfig(aws));
  }

  /** Startup log label. */
  describe(): string {
    return `Amazon SNS (${this.aws.region}${this.senderId ? `, sender id ${this.senderId}` : ''})`;
  }

  /** Sends one SMS; returns the SNS MessageId. */
  async send(message: SmsMessage): Promise<DeliveryResult> {
    const senderId = message.from ?? this.senderId;
    try {
      const result = await this.client.send(
        new PublishCommand({
          PhoneNumber: message.to,
          Message: message.body,
          MessageAttributes: {
            // Transactional = higher delivery priority (OTPs, alerts).
            'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
            ...(senderId && {
              'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: senderId },
            }),
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
