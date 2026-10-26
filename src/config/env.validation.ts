/**
 * Environment variable validation. Runs once at startup; if any variable is
 * invalid the app refuses to start, which surfaces misconfiguration early
 * (e.g. EMAIL_PROVIDER=ses without AWS_REGION) instead of at first send.
 */

import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { parseCipherKeys } from '../utils/crypto/field-cipher.js';
import {
  AppRole,
  DeployEnv,
  EmailProviderName,
  PushProviderName,
  SmsProviderName,
} from '../constant/index.js';

/** Allowed values for NODE_ENV. */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** Allowed values for boolean-like variables. */
const BOOLEAN = ['true', 'false'];

/**
 * Describes every validated environment variable with its rules and
 * default. Each property name matches the environment variable name.
 * Variables without rules (credentials etc.) pass through unchanged.
 */
class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsEnum(AppRole)
  APP_ROLE: AppRole = AppRole.All;

  // Deployment environment; everything except local reads AWS Secrets Manager.
  @IsEnum(DeployEnv)
  APP_ENV: DeployEnv = DeployEnv.Local;

  // gRPC API (api / all roles).
  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT: number = 50051;

  @IsInt()
  @Min(1024)
  GRPC_MAX_MESSAGE_BYTES: number = 8 * 1024 * 1024;

  @IsOptional()
  @IsIn(BOOLEAN)
  GRPC_REFLECTION?: string;

  // HTTP/JSON gateway + Swagger (api / all roles); 0 disables.
  @IsInt()
  @Min(0)
  @Max(65535)
  HTTP_PORT: number = 3000;

  @IsInt()
  @Min(1024)
  BODY_LIMIT_BYTES: number = 5 * 1024 * 1024;

  @IsOptional()
  @IsIn(BOOLEAN)
  SWAGGER_ENABLED?: string;

  @IsString()
  SWAGGER_PATH: string = 'docs';

  // Health + metrics over plain HTTP (every role).
  @IsInt()
  @Min(0)
  @Max(65535)
  OPS_PORT: number = 9464;

  @IsIn(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
  LOG_LEVEL: string = 'info';

  @IsString()
  APP_NAME: string = 'Communication Hub';

  // Admin routes are disabled when this is not set.
  @IsOptional()
  @IsString()
  @MinLength(32, { message: 'ADMIN_API_KEY must be at least 32 characters' })
  ADMIN_API_KEY?: string;

  // PostgreSQL.
  @IsString()
  DB_HOST: string = 'localhost';

  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT: number = 5432;

  @IsString()
  DB_USERNAME: string = 'postgres';

  // Required: pg can't authenticate with an empty password.
  @IsString()
  @IsNotEmpty({ message: 'DB_PASSWORD must be set in .env' })
  DB_PASSWORD: string;

  @IsString()
  DB_NAME: string = 'communication_hub';

  @IsIn(BOOLEAN)
  DB_SSL: string = 'false';

  @IsInt()
  @Min(1)
  @Max(200)
  DB_POOL_SIZE: number = 10;

  // Redis.
  @IsString()
  REDIS_HOST: string = 'localhost';

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsInt()
  @Min(0)
  REDIS_DB: number = 0;

  @IsIn(BOOLEAN)
  REDIS_TLS: string = 'false';

  @IsIn(BOOLEAN)
  REDIS_CLUSTER: string = 'false';

  // Queue.
  @IsInt()
  @Min(1)
  @Max(20)
  QUEUE_ATTEMPTS: number = 5;

  @IsInt()
  @Min(100)
  QUEUE_BACKOFF_MS: number = 5000;

  // In-app inbox retention.
  @IsInt()
  @Min(1)
  @Max(3650)
  INBOX_RETENTION_DAYS: number = 90;

  // Rate limiting per tenant.
  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS: number = 60;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 600;

  // Providers.
  @IsEnum(EmailProviderName)
  EMAIL_PROVIDER: EmailProviderName = EmailProviderName.Console;

  @IsEnum(SmsProviderName)
  SMS_PROVIDER: SmsProviderName = SmsProviderName.Console;

  @IsEnum(PushProviderName)
  PUSH_PROVIDER: PushProviderName = PushProviderName.Console;

  @IsString()
  MAIL_FROM: string = 'Communication Hub <no-reply@example.com>';

  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  // Send-path configuration caches (seconds).
  @IsInt()
  @Min(1)
  PROVIDER_CACHE_TTL_SECONDS: number = 300;

  @IsInt()
  @Min(1)
  SENDER_CACHE_TTL_SECONDS: number = 300;

  @IsInt()
  @Min(1)
  TEMPLATE_CACHE_TTL_SECONDS: number = 300;

  @IsIn(BOOLEAN)
  SMTP_SECURE: string = 'false';
}

/**
 * Variables that must be set for the selected provider. Checked after the
 * per-variable rules so the error names exactly what is missing.
 */
const PROVIDER_REQUIREMENTS: Record<string, Record<string, string[][]>> = {
  EMAIL_PROVIDER: {
    [EmailProviderName.Smtp]: [['SMTP_HOST']],
    [EmailProviderName.Sendgrid]: [['SENDGRID_API_KEY']],
    [EmailProviderName.Ses]: [['AWS_REGION']],
  },
  SMS_PROVIDER: {
    // Twilio needs credentials plus a sender (number OR messaging service).
    [SmsProviderName.Twilio]: [
      ['TWILIO_ACCOUNT_SID'],
      ['TWILIO_AUTH_TOKEN'],
      ['TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID'],
    ],
    [SmsProviderName.Sns]: [['AWS_REGION']],
  },
  PUSH_PROVIDER: {},
};

/**
 * Cross-field checks that class-validator can't express: credentials
 * required by the selected platform providers, encryption keys, and
 * production-only requirements.
 * Returns one message per problem.
 */
function checkProviderRequirements(env: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [selector, providers] of Object.entries(PROVIDER_REQUIREMENTS)) {
    const selected = env[selector] as string | undefined;
    for (const anyOf of providers[selected ?? ''] ?? []) {
      if (!anyOf.some((name) => env[name])) {
        errors.push(`${anyOf.join(' or ')} must be set when ${selector}=${selected}`);
      }
    }
  }
  // Encryption keys are required everywhere: recipients are never stored in clear.
  try {
    parseCipherKeys({
      keys: env.ENCRYPTION_KEYS as string | undefined,
      activeKeyId: env.ENCRYPTION_ACTIVE_KEY as string | undefined,
      blindIndexKey: env.BLIND_INDEX_KEY as string | undefined,
    });
  } catch (err) {
    errors.push(...(err as Error).message.split('\n- '));
  }
  const deployed = env.APP_ENV && env.APP_ENV !== DeployEnv.Local;
  if ((env.NODE_ENV === NodeEnv.Production || deployed) && !env.ADMIN_API_KEY) {
    errors.push(`ADMIN_API_KEY must be set (APP_ENV=${String(env.APP_ENV ?? DeployEnv.Local)})`);
  }
  // Deployed environments must really deliver: console providers only log.
  // (The platform default is what tenants without provider configs use.)
  if (deployed) {
    for (const selector of ['EMAIL_PROVIDER', 'SMS_PROVIDER', 'PUSH_PROVIDER']) {
      if (!env[selector] || env[selector] === 'console') {
        errors.push(`${selector} must be a real provider (not console) when APP_ENV=${String(env.APP_ENV)}`);
      }
    }
  }
  return errors;
}

/**
 * Validator passed to ConfigModule. Receives the raw env object and either
 * returns the validated values or throws.
 */
export function validateEnv(config: Record<string, unknown>) {
  // Turn strings like "3000" into numbers where the property type is number.
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  const messages = [
    ...errors.flatMap((e) => Object.values(e.constraints ?? {})),
    ...checkProviderRequirements(config),
  ];
  if (messages.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${messages.join('\n- ')}`,
    );
  }
  // Keep variables that have no rule (SMTP_USER, TWILIO_*, ...) as well.
  return { ...config, ...validated };
}
