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

  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  API_PREFIX: string = 'api';

  @IsString()
  CORS_ORIGINS: string = '*';

  @IsIn(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
  LOG_LEVEL: string = 'info';

  @IsIn(BOOLEAN)
  SWAGGER_ENABLED: string = 'true';

  @IsString()
  SWAGGER_PATH: string = 'docs';

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
 * required by the selected providers, and production-only requirements.
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
  const deployed = env.APP_ENV && env.APP_ENV !== DeployEnv.Local;
  if ((env.NODE_ENV === NodeEnv.Production || deployed) && !env.ADMIN_API_KEY) {
    errors.push(`ADMIN_API_KEY must be set (APP_ENV=${String(env.APP_ENV ?? DeployEnv.Local)})`);
  }
  // Deployed environments must really deliver: console providers only log.
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
