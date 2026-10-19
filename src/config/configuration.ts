/**
 * Typed configuration factory. Converts raw environment variables into a
 * structured object available through ConfigService under the `app` key.
 */

/** Shape of the application configuration. */
export interface AppConfig {
  // Runtime environment: development | production | test.
  env: string;
  // Display name of the service (also used as the Swagger title).
  name: string;
  // HTTP port the server listens on.
  port: number;
  // Global route prefix, e.g. "api" -> /api/...
  apiPrefix: string;
  // Allowed CORS origins, or '*' to allow all.
  corsOrigins: string[] | '*';
  // Swagger settings: whether it's enabled and the URL path it's served on.
  swagger: { enabled: boolean; path: string };
  // NestJS Observe credentials.
  observe: { appKey: string; appSecret: string };
  // Outgoing email settings.
  mail: MailConfig;
  // PostgreSQL connection.
  database: DatabaseConfig;
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
}

/** Email sender settings. Without smtp.host, emails are logged to the console. */
export interface MailConfig {
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
}

/**
 * Builds the configuration object. Registered in ConfigModule via `load`.
 * Defaults are provided so the app runs without a .env file.
 */
export default (): { app: AppConfig } => {
  // Raw CORS setting: "*" or a comma-separated list of origins.
  const origins = process.env.CORS_ORIGINS ?? '*';
  // Return everything under the `app` namespace.
  return {
    app: {
      // Current environment, defaulting to development.
      env: process.env.NODE_ENV ?? 'development',
      // Service display name.
      name: process.env.APP_NAME ?? 'Communication Hub',
      // Port parsed from string to a base-10 integer.
      port: parseInt(process.env.PORT ?? '3000', 10),
      // Global route prefix.
      apiPrefix: process.env.API_PREFIX ?? 'api',
      // Keep '*' as-is, otherwise split the list and trim whitespace.
      corsOrigins:
        origins === '*' ? '*' : origins.split(',').map((o) => o.trim()),
      swagger: {
        // Swagger is on unless SWAGGER_ENABLED is set to something other than "true".
        enabled: (process.env.SWAGGER_ENABLED ?? 'true') === 'true',
        // URL path for the Swagger UI.
        path: process.env.SWAGGER_PATH ?? 'docs',
      },
      observe: {
        // `||` (not `??`) so an empty value in .env also falls back to the placeholder.
        appKey: process.env.OBSERVE_APP_KEY || 'YOUR_APP_KEY',
        appSecret: process.env.OBSERVE_APP_SECRET || 'YOUR_APP_SECRET',
      },
      mail: {
        from:
          process.env.MAIL_FROM ?? 'Communication Hub <no-reply@example.com>',
        smtp: {
          // `||` so an empty value in .env means "not configured".
          host: process.env.SMTP_HOST || undefined,
          port: parseInt(process.env.SMTP_PORT ?? '587', 10),
          secure: process.env.SMTP_SECURE === 'true',
          user: process.env.SMTP_USER || undefined,
          pass: process.env.SMTP_PASS || undefined,
        },
      },
      database: {
        host: process.env.DB_HOST ?? 'localhost',
        port: parseInt(process.env.DB_PORT ?? '5432', 10),
        username: process.env.DB_USERNAME ?? 'postgres',
        password: process.env.DB_PASSWORD ?? '',
        name: process.env.DB_NAME ?? 'communication_hub',
        ssl: process.env.DB_SSL === 'true',
        logging: process.env.DB_LOGGING === 'true',
      },
    },
  };
};
