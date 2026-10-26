/**
 * Contracts shared by every delivery provider (SMTP, SES, SendGrid, Twilio,
 * SNS, FCM, console). Instances are created per provider config (tenant or
 * platform default) by the ProviderRegistry, see modules/provider.
 */

/** A fully rendered email. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
}

/** A fully rendered SMS. */
export interface SmsMessage {
  to: string;
  body: string;
  // Sender override (tenant-specific number / alphanumeric id).
  from?: string;
}

/** A fully rendered push notification for one or more devices. */
export interface PushMessage {
  tokens: string[];
  title?: string;
  body: string;
  // Custom key/value payload delivered to the app (FCM data, strings only).
  data?: Record<string, string>;
  // Data-only message: nothing is displayed, the app handles it (in-app
  // inbox sync). title/body are ignored.
  silent?: boolean;
}

/** What a provider returns after the vendor accepted the message. */
export interface DeliveryResult {
  provider: string;
  providerMessageId: string;
  // Push only: tokens the vendor reported as dead; they get deactivated.
  invalidTokens?: string[];
}

/** An email vendor integration. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<DeliveryResult>;
  // Release pooled connections on shutdown.
  close?(): Promise<void>;
  // Human-readable target for startup logs (no secrets).
  describe(): string;
  // Optional real connectivity check, run in the background at startup.
  verify?(): Promise<void>;
}

/** An SMS vendor integration. */
export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<DeliveryResult>;
  // Release pooled connections on shutdown.
  close?(): Promise<void>;
  // Human-readable target for startup logs (no secrets).
  describe(): string;
  // Optional real connectivity check, run in the background at startup.
  verify?(): Promise<void>;
}

/** A push vendor integration. */
export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<DeliveryResult>;
  // Release pooled connections on shutdown.
  close?(): Promise<void>;
  // Human-readable target for startup logs (no secrets).
  describe(): string;
  // Optional real connectivity check, run in the background at startup.
  verify?(): Promise<void>;
}

/** Any channel's provider. */
export type ChannelProvider = EmailProvider | SmsProvider | PushProvider;

/**
 * Thrown by providers when retrying can't help (invalid address, number
 * not reachable, unregistered device, rejected content). The worker marks
 * the notification failed immediately instead of burning retries.
 * Any other error is treated as transient and retried with backoff.
 */
export class PermanentDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly invalidTokens: string[] = [],
  ) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}
