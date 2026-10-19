/**
 * Real email delivery over SMTP (Gmail, SES SMTP, Mailgun, Mailtrap, ...).
 * Used automatically when SMTP_HOST is set.
 */

// Nodemailer: SMTP client.
import nodemailer, { Transporter } from 'nodemailer';
// Email settings from configuration.
import { MailConfig } from '../../../config/configuration.js';
// Channel enum.
import { NotificationChannel } from '../enums/notification-channel.enum.js';
// The provider contract this class implements.
import {
  ChannelProvider,
  ChannelSendResult,
  OutgoingMessage,
} from './channel-provider.interface.js';

export class SmtpEmailProvider implements ChannelProvider {
  readonly channel = NotificationChannel.Email;
  // Reusable SMTP connection.
  private readonly transporter: Transporter;

  constructor(private readonly config: MailConfig) {
    const { host, port, secure, user, pass } = config.smtp;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      // Only authenticate when credentials are configured.
      auth: user ? { user, pass } : undefined,
    });
  }

  /** Sends the email; nodemailer throws on failure. */
  async send(message: OutgoingMessage): Promise<ChannelSendResult> {
    const info = await this.transporter.sendMail({
      from: this.config.from,
      to: message.recipient,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { providerMessageId: info.messageId };
  }
}
