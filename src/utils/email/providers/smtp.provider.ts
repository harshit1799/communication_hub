/**
 * Email over SMTP (Gmail, SES SMTP, Mailgun, Postmark, Mailtrap, ...).
 * Uses a pooled transport so connections are reused across sends.
 */

import nodemailer, { Transporter } from 'nodemailer';
import { MailConfig } from '../../../config/configuration.js';
import {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  PermanentDeliveryError,
} from '../../channel/channel.types.js';

/** SMTP provider; the pool size follows the email worker concurrency. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transporter: Transporter;
  private readonly target: string;

  constructor(config: MailConfig, maxConnections: number) {
    const { host, port, secure, user, pass } = config.smtp;
    this.target = `SMTP ${host}:${port}${secure ? ' (TLS)' : ''}, pool ${maxConnections}`;
    this.transporter = nodemailer.createTransport({
      pool: true,
      maxConnections,
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });
  }

  /** Sends one email; returns the SMTP Message-ID. */
  async send(message: EmailMessage): Promise<DeliveryResult> {
    try {
      const info = await this.transporter.sendMail(message);
      return { provider: this.name, providerMessageId: info.messageId };
    } catch (err) {
      const { responseCode, code } = err as { responseCode?: number; code?: string };
      // 5xx replies (e.g. 550 mailbox unavailable) and rejected envelopes
      // won't succeed on retry; 4xx and network errors might.
      if ((responseCode && responseCode >= 500) || code === 'EENVELOPE') {
        throw new PermanentDeliveryError((err as Error).message, this.name);
      }
      throw err;
    }
  }

  /** Closes the pooled SMTP connections. */
  /** Startup log label. */
  describe(): string {
    return this.target;
  }

  /** Connects and authenticates once (SMTP handshake), without sending. */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): Promise<void> {
    this.transporter.close();
    return Promise.resolve();
  }
}
