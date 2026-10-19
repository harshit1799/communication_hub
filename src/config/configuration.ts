/**
 * Typed configuration factory. Converts raw environment variables into a
 * structured object available through ConfigService under the `app` key.
 * Variables are validated first by env.validation.ts.
 */

import {
  AppRole,
  DeployEnv,
  EmailProviderName,
  PushProviderName,
  SmsProviderName,
} from '../constant/index.js';

/** Shape of the application configuration. */
export interface AppConfig {
  // Runtime mode: development | production | test (logging, test setup).
  env: string;
  // Deployment environment: local | development | staging | preprod | production.
  deployEnv: DeployEnv;
  // Display name of the service (Swagger title, default brand in templates).
  name: string;
  // Whether this process serves HTTP, runs queue workers, or both.
  role: AppRole;
  port: number;
  // Global route prefix, e.g. "api" -> /api/...
  apiPrefix: string;
  // Allowed CORS origins, or '*' to allow all.
  corsOrigins: string[] | '*';
  // Max request body in bytes (bulk sends can be large).
  bodyLimit: number;
  // Log level for pino (trace | debug | info | warn | error | fatal).
  logLevel: string;
  swagger: SwaggerConfig;
  observe: { appKey: string; appSecret: string };
  auth: AuthConfig;
  throttle: { ttlSeconds: number; limit: number };
  database: DatabaseConfig;
  redis: RedisConfig;
  queue: QueueConfig;
  mail: MailConfig;
  sms: SmsConfig;
  push: PushConfig;
  aws: AwsConfig;
  bootstrap: BootstrapConfig;
}

/** Swagger UI settings. */
export interface SwaggerConfig {
  enabled: boolean;
  path: string;
  // When both are set, the docs are protected with HTTP basic auth.
  user?: string;
  pass?: string;
}

/** Authentication settings for tenant and admin routes. */
export interface AuthConfig {
  // Secret for the /admin routes (tenant + API key management).
  adminApiKey?: string;
  // How long a resolved API key is cached in Redis.
  apiKeyCacheTtlSeconds: number;
}

/** PostgreSQL connection settings. */
export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
  // Use TLS (required by most managed databases: RDS, Neon, Supabase, ...).
  ssl: boolean;
  // Log every SQL query (handy while developing).
  logging: boolean;
  // Max connections per process in the pg pool.
  poolSize: number;
}

/** Redis connection, shared by the cache, the rate limiter and BullMQ. */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  tls: boolean;
  // Connect to a Redis Cluster (e.g. ElastiCache cluster mode).
  cluster: boolean;
  // Namespace for every key this service writes.
  keyPrefix: string;
}

/** Delivery queue behaviour: retries, backoff and worker tuning. */
export interface QueueConfig {
  // Delivery attempts per notification (1 = no retry).
  attempts: number;
  // Base delay for exponential backoff between attempts.
  backoffMs: number;
  // Re-enqueue notifications stuck in an in-flight state for this long.
  stuckAfterMinutes: number;
  // Per-channel worker tuning.
  workers: Record<'email' | 'sms' | 'push', WorkerConfig>;
}

/** Tuning for one channel worker (EMAIL_*, SMS_*, PUSH_*). */
export interface WorkerConfig {
  // Jobs processed in parallel per process.
  concurrency: number;
  // Max jobs per `rateDurationMs` across ALL workers (vendor rate limits).
  rateMax: number;
  rateDurationMs: number;
}

/** Email delivery settings. */
export interface MailConfig {
  provider: EmailProviderName;
  // Default "From" address, e.g. "Acme <no-reply@acme.com>".
  from: string;
  smtp: {
    host?: string;
    port: number;
    // true for port 465 (TLS), false for 587/25 (STARTTLS).
    secure: boolean;
    user?: string;
    pass?: string;
  };
  sendgridApiKey?: string;
}

/** SMS delivery settings. Only the selected provider needs its values. */
export interface SmsConfig {
  provider: SmsProviderName;
  twilio: {
    accountSid?: string;
    authToken?: string;
    // Sender number, or a Messaging Service SID (preferred at scale).
    from?: string;
    messagingServiceSid?: string;
  };
  // Alphanumeric sender id for SNS (not supported in every country).
  snsSenderId?: string;
}

/** Push delivery settings. */
export interface PushConfig {
  provider: PushProviderName;
  // Service account JSON (raw or base64). Empty = Application Default Credentials.
  firebaseServiceAccount?: string;
}

/**
 * AWS credentials for SES/SNS. Leave the keys empty to use the default
 * provider chain (IAM role, IRSA, instance profile), which is preferred.
 */
export interface AwsConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Optional tenant created on startup (handy for local development). */
export interface BootstrapConfig {
  tenantName?: string;
  tenantSlug?: string;
  tenantApiKey?: string;
}

/**
 * Returns undefined for unset or empty values. Uses `||` instead of `??`
 * so an empty value in .env means "not set".
 */
const optional = (value: string | undefined) => value || undefined;
/** Parses an integer variable, using `fallback` when unset or empty. */
const int = (value: string | undefined, fallback: number) =>
  parseInt(value || String(fallback), 10);

/** Reads the role directly from the environment (used before DI exists). */
export const readRole = (): AppRole =>
  (process.env.APP_ROLE as AppRole) || AppRole.All;

/**
 * Builds the configuration object. Registered in ConfigModule via `load`.
 * Defaults are provided so the app runs with a minimal .env file.
 */
export default (): { app: AppConfig } => {
  const env = process.env;
  const origins = env.CORS_ORIGINS ?? '*';
  const worker = (channel: string, concurrency: number): WorkerConfig => ({
    concurrency: int(env[`${channel}_WORKER_CONCURRENCY`], concurrency),
    rateMax: int(env[`${channel}_RATE_MAX`], 100),
    rateDurationMs: int(env[`${channel}_RATE_DURATION_MS`], 1000),
  });

  return {
    app: {
      env: env.NODE_ENV ?? 'development',
      deployEnv: (env.APP_ENV as DeployEnv) || DeployEnv.Local,
      name: env.APP_NAME ?? 'Communication Hub',
      role: readRole(),
      port: int(env.PORT, 3000),
      apiPrefix: env.API_PREFIX ?? 'api',
      corsOrigins:
        origins === '*' ? '*' : origins.split(',').map((o) => o.trim()),
      bodyLimit: int(env.BODY_LIMIT_BYTES, 5 * 1024 * 1024),
      logLevel: env.LOG_LEVEL ?? 'info',
      swagger: {
        enabled: (env.SWAGGER_ENABLED ?? 'true') === 'true',
        path: env.SWAGGER_PATH ?? 'docs',
        user: optional(env.SWAGGER_USER),
        pass: optional(env.SWAGGER_PASS),
      },
      observe: {
        appKey: env.OBSERVE_APP_KEY || 'YOUR_APP_KEY',
        appSecret: env.OBSERVE_APP_SECRET || 'YOUR_APP_SECRET',
      },
      auth: {
        adminApiKey: optional(env.ADMIN_API_KEY),
        apiKeyCacheTtlSeconds: int(env.API_KEY_CACHE_TTL_SECONDS, 60),
      },
      throttle: {
        ttlSeconds: int(env.THROTTLE_TTL_SECONDS, 60),
        limit: int(env.THROTTLE_LIMIT, 600),
      },
      database: {
        host: env.DB_HOST ?? 'localhost',
        port: int(env.DB_PORT, 5432),
        username: env.DB_USERNAME ?? 'postgres',
        password: env.DB_PASSWORD ?? '',
        name: env.DB_NAME ?? 'communication_hub',
        ssl: env.DB_SSL === 'true',
        logging: env.DB_LOGGING === 'true',
        poolSize: int(env.DB_POOL_SIZE, 10),
      },
      redis: {
        host: env.REDIS_HOST ?? 'localhost',
        port: int(env.REDIS_PORT, 6379),
        password: optional(env.REDIS_PASSWORD),
        db: int(env.REDIS_DB, 0),
        tls: env.REDIS_TLS === 'true',
        cluster: env.REDIS_CLUSTER === 'true',
        keyPrefix: env.REDIS_KEY_PREFIX ?? 'chub',
      },
      queue: {
        attempts: int(env.QUEUE_ATTEMPTS, 5),
        backoffMs: int(env.QUEUE_BACKOFF_MS, 5000),
        stuckAfterMinutes: int(env.QUEUE_STUCK_AFTER_MINUTES, 10),
        workers: {
          email: worker('EMAIL', 20),
          sms: worker('SMS', 10),
          push: worker('PUSH', 20),
        },
      },
      mail: {
        provider:
          (env.EMAIL_PROVIDER as EmailProviderName) ||
          EmailProviderName.Console,
        from: env.MAIL_FROM ?? 'Communication Hub <no-reply@example.com>',
        smtp: {
          host: optional(env.SMTP_HOST),
          port: int(env.SMTP_PORT, 587),
          secure: env.SMTP_SECURE === 'true',
          user: optional(env.SMTP_USER),
          pass: optional(env.SMTP_PASS),
        },
        sendgridApiKey: optional(env.SENDGRID_API_KEY),
      },
      sms: {
        provider:
          (env.SMS_PROVIDER as SmsProviderName) || SmsProviderName.Console,
        twilio: {
          accountSid: optional(env.TWILIO_ACCOUNT_SID),
          authToken: optional(env.TWILIO_AUTH_TOKEN),
          from: optional(env.TWILIO_FROM),
          messagingServiceSid: optional(env.TWILIO_MESSAGING_SERVICE_SID),
        },
        snsSenderId: optional(env.SNS_SENDER_ID),
      },
      push: {
        provider:
          (env.PUSH_PROVIDER as PushProviderName) || PushProviderName.Console,
        firebaseServiceAccount: optional(env.FIREBASE_SERVICE_ACCOUNT),
      },
      aws: {
        region: env.AWS_REGION ?? 'us-east-1',
        accessKeyId: optional(env.AWS_ACCESS_KEY_ID),
        secretAccessKey: optional(env.AWS_SECRET_ACCESS_KEY),
      },
      bootstrap: {
        tenantName: optional(env.BOOTSTRAP_TENANT_NAME),
        tenantSlug: optional(env.BOOTSTRAP_TENANT_SLUG),
        tenantApiKey: optional(env.BOOTSTRAP_TENANT_API_KEY),
      },
    },
  };
};
