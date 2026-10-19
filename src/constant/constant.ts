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
}

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

/** Email vendors (EMAIL_PROVIDER). `console` logs instead of sending. */
export enum EmailProviderName {
  Console = 'console',
  Smtp = 'smtp',
  Ses = 'ses',
  Sendgrid = 'sendgrid',
}

/** SMS vendors (SMS_PROVIDER). */
export enum SmsProviderName {
  Console = 'console',
  Twilio = 'twilio',
  Sns = 'sns',
}

/** Push vendors (PUSH_PROVIDER). */
export enum PushProviderName {
  Console = 'console',
  Fcm = 'fcm',
}

/** One BullMQ queue per channel, so a slow vendor can't hold up the others. */
export const CHANNEL_QUEUE: Record<NotificationChannel, string> = {
  [NotificationChannel.Email]: 'notifications-email',
  [NotificationChannel.Sms]: 'notifications-sms',
  [NotificationChannel.Push]: 'notifications-push',
};

/** Queue for periodic housekeeping jobs (stuck-notification sweeper). */
export const MAINTENANCE_QUEUE = 'maintenance';
/** Job names on the maintenance queue. */
export const MAINTENANCE_JOB = {
  REQUEUE_STUCK: 'requeue-stuck',
};

/** HTTP headers (lower-case, as Node exposes them). */
export const HEADER = {
  API_KEY: 'x-api-key',
  ADMIN_KEY: 'x-admin-key',
  REQUEST_ID: 'x-request-id',
  LANGUAGE: 'language',
  // Standard name (IETF draft, Stripe); Node lower-cases header names.
  IDEMPOTENCY_KEY: 'idempotency-key',
  // Set on responses that returned an earlier result for the same key.
  IDEMPOTENT_REPLAYED: 'idempotent-replayed',
};

/** Swagger security scheme names. */
export const SECURITY = {
  TENANT: 'tenant-api-key',
  ADMIN: 'admin-api-key',
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
  // Max length of an idempotency key (header or body).
  IDEMPOTENCY_KEY_MAX: 255,
  // Rows re-enqueued per sweeper run.
  SWEEP_BATCH: 500,
};

/** Redis key builders. Every key is namespaced by REDIS_KEY_PREFIX. */
export const REDIS_KEY = {
  apiKey: (hash: string) => `apikey:${hash}`,
  throttle: (key: string) => `throttle:${key}`,
};

/** E.164 phone number, e.g. +14155550123. */
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/** Template names: file names in src/views/<channel>/ without extension. */
export const TEMPLATE_NAME_REGEX = /^[a-z0-9-]+$/;
