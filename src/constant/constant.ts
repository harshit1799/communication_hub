/**
 * Application-wide constants and enums shared across modules.
 */

/** Delivery channels. The string values are what clients send in `channel`. */
export enum NotificationChannel {
  // recipient = email address
  Email = 'email',
  // recipient = E.164 phone number
  Sms = 'sms',
  // recipient = device token, or `userId` to reach every registered device
  Push = 'push',
  // userId only: stored in the user's inbox, devices signalled through FCM
  InApp = 'in_app',
}

/**
 * Channels delivered by a vendor provider (provider_configs). In-app is
 * delivered to the inbox table and signals devices through the tenant's
 * push providers.
 */
export type ProviderChannel = Exclude<NotificationChannel, NotificationChannel.InApp>;

/** The provider channel used to deliver (or, for in-app, to signal) a channel. */
export const providerChannelOf = (channel: NotificationChannel): ProviderChannel =>
  channel === NotificationChannel.InApp ? NotificationChannel.Push : channel;

/**
 * Lifecycle of a notification:
 *   queued -> processing -> sent
 *                        -> retrying -> processing -> ...
 *                        -> failed            (permanent error / attempts exhausted)
 *   queued | retrying -> cancelled            (cancelled by the client)
 */
export enum NotificationStatus {
  Queued = 'queued',
  Processing = 'processing',
  Retrying = 'retrying',
  Sent = 'sent',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/** Statuses a worker may still act on. Everything else is terminal. */
export const IN_FLIGHT_STATUSES = [
  NotificationStatus.Queued,
  NotificationStatus.Processing,
  NotificationStatus.Retrying,
];

/** Client-facing priority, mapped to BullMQ priorities (lower = sooner). */
export enum NotificationPriority {
  High = 'high',
  Normal = 'normal',
  Low = 'low',
}

/** BullMQ priority per client priority. */
export const QUEUE_PRIORITY: Record<NotificationPriority, number> = {
  [NotificationPriority.High]: 1,
  [NotificationPriority.Normal]: 5,
  [NotificationPriority.Low]: 10,
};

/** Device platforms for push tokens. */
export enum DevicePlatform {
  Ios = 'ios',
  Android = 'android',
  Web = 'web',
}

/**
 * Deployment environment (APP_ENV), same names as the backend service.
 * Everything except `local` loads its configuration from AWS Secrets Manager.
 */
export enum DeployEnv {
  Local = 'local',
  Development = 'development',
  Staging = 'staging',
  Preprod = 'preprod',
  Production = 'production',
}

/**
 * AWS Secrets Manager settings, like the backend's AWS_SECRET_MANGER. The
 * secret is a JSON object of environment variables named
 * "communication-hub/<APP_ENV>-env" (backend: "repit/<NODE_ENV>-env");
 * AWS_SECRET_NAME overrides it. Getters, so the values are read when the
 * secret is fetched, not when this file is imported.
 */
export const AWS_SECRET_MANAGER = {
  get REGION(): string {
    return process.env.AWS_REGION || 'us-east-1';
  },
  get SECRET_NAME(): string {
    return process.env.AWS_SECRET_NAME || `communication-hub/${process.env.APP_ENV}-env`;
  },
};

/**
 * What this process runs. Split API and workers in production so each can
 * be scaled on its own; `all` is convenient for local development.
 */
export enum AppRole {
  Api = 'api',
  Worker = 'worker',
  All = 'all',
}

/**
 * Every delivery provider implementation, by name. Stored in
 * provider_configs.provider and recorded on every attempt.
 */
export enum ProviderKind {
  Console = 'console',
  Smtp = 'smtp',
  Ses = 'ses',
  Sendgrid = 'sendgrid',
  Twilio = 'twilio',
  Sns = 'sns',
  Fcm = 'fcm',
}

/** Which provider kinds can deliver on which channel. */
export const CHANNEL_PROVIDERS: Record<ProviderChannel, ProviderKind[]> = {
  [NotificationChannel.Email]: [ProviderKind.Console, ProviderKind.Smtp, ProviderKind.Ses, ProviderKind.Sendgrid],
  [NotificationChannel.Sms]: [ProviderKind.Console, ProviderKind.Twilio, ProviderKind.Sns],
  [NotificationChannel.Push]: [ProviderKind.Console, ProviderKind.Fcm],
};

/** Channels that have a sender identity (push has none). */
export const SENDER_CHANNELS = [NotificationChannel.Email, NotificationChannel.Sms];

/** How a sender rule matches a notification (see SenderResolver). */
export enum SenderRuleMatch {
  // Always (typically combined with a template id).
  Any = 'any',
  // Recipient starts with the value, e.g. "+91" (SMS).
  RecipientPrefix = 'recipient_prefix',
  // Recipient's email domain equals the value, e.g. "gmail.com".
  RecipientDomain = 'recipient_domain',
}

/** Platform default email vendor (EMAIL_PROVIDER). `console` logs instead of sending. */
export enum EmailProviderName {
  Console = 'console',
  Smtp = 'smtp',
  Ses = 'ses',
  Sendgrid = 'sendgrid',
}

/** Platform default SMS vendor (SMS_PROVIDER). */
export enum SmsProviderName {
  Console = 'console',
  Twilio = 'twilio',
  Sns = 'sns',
}

/** Platform default push vendor (PUSH_PROVIDER). */
export enum PushProviderName {
  Console = 'console',
  Fcm = 'fcm',
}

/** One BullMQ queue per channel, so a slow vendor can't hold up the others. */
export const CHANNEL_QUEUE: Record<NotificationChannel, string> = {
  [NotificationChannel.Email]: 'notifications-email',
  [NotificationChannel.Sms]: 'notifications-sms',
  [NotificationChannel.Push]: 'notifications-push',
  [NotificationChannel.InApp]: 'notifications-in-app',
};

/** Queue for periodic housekeeping jobs (stuck-notification sweeper). */
export const MAINTENANCE_QUEUE = 'maintenance';
/** Job names on the maintenance queue. */
export const MAINTENANCE_JOB = {
  REQUEUE_STUCK: 'requeue-stuck',
  // Deletes expired inbox messages (INBOX_RETENTION_DAYS).
  PURGE_INBOX: 'purge-inbox',
};

/** gRPC metadata keys (lower-case, as gRPC requires). */
export const METADATA = {
  API_KEY: 'x-api-key',
  ADMIN_KEY: 'x-admin-key',
  REQUEST_ID: 'x-request-id',
  LANGUAGE: 'language',
  // Trailing metadata on errors: machine-readable type and JSON context.
  ERROR_TYPE: 'error-type',
  ERROR_DATA: 'error-data',
};

/** Prefix of generated tenant API keys, so leaked keys are easy to grep for. */
export const API_KEY_PREFIX = 'chk_';

/** Hard limits that protect the service. */
export const LIMITS = {
  // Max notifications in one bulk request.
  BULK_MAX: 500,
  // Max page size for list endpoints.
  PAGE_SIZE_MAX: 100,
  PAGE_SIZE_DEFAULT: 20,
  // FCM accepts at most 500 tokens per multicast.
  FCM_MULTICAST_MAX: 500,
  // Notifications can be scheduled at most this far ahead.
  SCHEDULE_MAX_DAYS: 30,
  // Max length of an idempotency key.
  IDEMPOTENCY_KEY_MAX: 255,
  // Max size of one template part (subject/body/html).
  TEMPLATE_PART_MAX: 200_000,
  // Compiled template versions kept in memory per process (LRU).
  TEMPLATE_COMPILE_CACHE: 1000,
  // Rows re-enqueued per sweeper run.
  SWEEP_BATCH: 500,
  // Expired inbox rows deleted per statement (the purge loops until done).
  INBOX_PURGE_BATCH: 5000,
  // Max ids per MarkInboxMessagesRead call.
  INBOX_MARK_MAX: 500,
};

/** Redis key builders. Every key is namespaced by REDIS_KEY_PREFIX. */
export const REDIS_KEY = {
  apiKey: (hash: string) => `apikey:${hash}`,
  throttle: (key: string) => `throttle:${key}`,
  // Send-path configuration; deleted on every change (see the admin services).
  providers: (tenantId: string, channel: string) => `providers:${tenantId}:${channel}`,
  senders: (tenantId: string, channel: string) => `senders:${tenantId}:${channel}`,
  template: (tenantId: string, channel: string, name: string) => `tpl:${tenantId}:${channel}:${name}`,
  // Versions are immutable, so this entry never needs invalidating.
  templateVersion: (templateId: string, version: number) => `tplv:${templateId}:${version}`,
};

/** E.164 phone number, e.g. +14155550123. */
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/** Template names, e.g. "password-reset". */
export const TEMPLATE_NAME_REGEX = /^[a-z0-9-]+$/;
