/**
 * SMS through Twilio. Prefer a Messaging Service SID in production: Twilio
 * then picks sender numbers and handles throughput/geo-matching for you.
 */

import twilio from 'twilio';
import { SmsConfig } from '../../../config/configuration.js';
import {
  DeliveryResult,
  PermanentDeliveryError,
  SmsMessage,
  SmsProvider,
} from '../../channel/channel.types.js';

// https://www.twilio.com/docs/api/errors - recipient/content problems.
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' number cannot be reached
  21408, // region not enabled for this account
  21610, // recipient replied STOP (unsubscribed)
  21612, // 'To' number not reachable via this sender
  21614, // 'To' number is not a mobile number
  21617, // body too long
]);

/**
 * Twilio provider. Sender precedence: tenant `smsFrom`, then the
 * Messaging Service SID, then TWILIO_FROM.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  private readonly client: twilio.Twilio;

  constructor(private readonly config: SmsConfig['twilio']) {
    this.client = twilio(config.accountSid, config.authToken);
  }

  /** Startup log label: masked account SID and the default sender type. */
  describe(): string {
    const account = `${this.config.accountSid?.slice(0, 6) ?? '?'}…`;
    const sender = this.config.messagingServiceSid ? 'messaging service' : `number ${this.config.from}`;
    return `Twilio (account ${account}, sender: ${sender})`;
  }

  /** Sends one SMS; returns the Twilio message SID. */
  async send(message: SmsMessage): Promise<DeliveryResult> {
    try {
      const sender = message.from
        ? { from: message.from }
        : this.config.messagingServiceSid
          ? { messagingServiceSid: this.config.messagingServiceSid }
          : { from: this.config.from };
      const result = await this.client.messages.create({
        to: message.to,
        body: message.body,
        ...sender,
      });
      return { provider: this.name, providerMessageId: result.sid };
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code && PERMANENT_CODES.has(code)) {
        throw new PermanentDeliveryError((err as Error).message, this.name);
      }
      throw err;
    }
  }
}
