/**
 * Contract for delivery providers. Each channel (email, sms, ...) gets one
 * implementation; the service picks the right one at send time.
 */

// Channel enum used to identify which channel a provider handles.
import { NotificationChannel } from '../enums/notification-channel.enum.js';

// Dependency-injection token for the list of all registered providers.
// A Symbol guarantees it can't clash with any other token.
export const CHANNEL_PROVIDERS = Symbol('CHANNEL_PROVIDERS');

/** A fully prepared message, ready to hand to a provider. */
export interface OutgoingMessage {
  // Tenant (white-label client) sending the message.
  tenantId: string;
  // Channel to deliver through.
  channel: NotificationChannel;
  // Email address, phone number, device token or URL.
  recipient: string;
  // Subject/title (email and push).
  subject?: string;
  // Plain-text content.
  text?: string;
  // Rendered HTML (emails sent from a template).
  html?: string;
}

/** Value a provider returns after a successful send. */
export interface ChannelSendResult {
  // Id assigned by the external vendor (e.g. SMTP Message-ID, Twilio SID).
  providerMessageId: string;
}

/**
 * Contract every delivery provider (SMTP, SES, Twilio, FCM, ...) implements.
 * Register implementations in NotificationsModule under CHANNEL_PROVIDERS.
 */
export interface ChannelProvider {
  // The channel this provider delivers for.
  readonly channel: NotificationChannel;
  // Deliver the message; throw an error if delivery fails.
  send(message: OutgoingMessage): Promise<ChannelSendResult>;
}
