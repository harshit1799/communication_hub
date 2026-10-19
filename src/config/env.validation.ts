/**
 * Environment variable validation. Runs once at startup; if any variable is
 * invalid the app refuses to start, which surfaces misconfiguration early.
 */

// plainToInstance: converts a plain object into an instance of a class.
import { plainToInstance } from 'class-transformer';
// Validation decorators and the synchronous validator.
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/** Allowed values for NODE_ENV. */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Describes every supported environment variable with its rules and default.
 * Each property name matches the environment variable name.
 */
class EnvironmentVariables {
  // Must be one of the NodeEnv values; defaults to development.
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  // Must be an integer between 0 and 65535 (valid TCP port range).
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number = 3000;

  // Global route prefix.
  @IsString()
  API_PREFIX: string = 'api';

  // "*" or a comma-separated list of allowed origins.
  @IsString()
  CORS_ORIGINS: string = '*';

  // "true" to serve Swagger UI, anything else disables it.
  @IsString()
  SWAGGER_ENABLED: string = 'true';

  // URL path where Swagger UI is mounted.
  @IsString()
  SWAGGER_PATH: string = 'docs';

  // Service display name (white-label branding).
  @IsString()
  APP_NAME: string = 'Communication Hub';

  // Optional NestJS Observe app key.
  @IsOptional()
  @IsString()
  OBSERVE_APP_KEY?: string;

  // Optional NestJS Observe app secret.
  @IsOptional()
  @IsString()
  OBSERVE_APP_SECRET?: string;

  // Default sender address for emails.
  @IsString()
  MAIL_FROM: string = 'Communication Hub <no-reply@example.com>';

  // SMTP server; leave empty to log emails to the console instead.
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  // SMTP port (587 = STARTTLS, 465 = TLS).
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  // "true" for port 465 (TLS).
  @IsString()
  SMTP_SECURE: string = 'false';

  // Optional SMTP credentials.
  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  // PostgreSQL connection.
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

  // "true" to connect over TLS.
  @IsString()
  DB_SSL: string = 'false';

  // "true" to log SQL queries.
  @IsString()
  DB_LOGGING: string = 'false';
}

/**
 * Validator passed to ConfigModule. Receives the raw env object and either
 * returns the validated values or throws.
 */
export function validateEnv(config: Record<string, unknown>) {
  // Convert the raw env (all strings) into a class instance, turning
  // strings like "3000" into numbers where the property type is number.
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  // Run all decorator rules; missing properties are validated too.
  const errors = validateSync(validated, { skipMissingProperties: false });
  // If anything failed, stop startup with a readable error list.
  if (errors.length > 0) {
    // One readable line per problem, e.g. "- DB_PASSWORD must be set in .env".
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new Error(
      `Invalid environment configuration:\n- ${messages.join('\n- ')}`,
    );
  }
  // Return the validated (and type-converted) values.
  return validated;
}
