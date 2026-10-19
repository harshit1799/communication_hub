/**
 * Global HTTP setup shared by main.ts and the e2e tests, so both run the
 * application with exactly the same behaviour.
 */

// INestApplication: type of a running Nest app.
// ValidationPipe: validates incoming request data against DTO decorators.
// VersioningType: enum of supported API versioning strategies.
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
// helmet: Express middleware that sets secure HTTP response headers.
import helmet from 'helmet';
// AppConfig: typed application configuration.
import { AppConfig } from './config/configuration.js';

/**
 * Applies all application-wide settings to the given Nest app.
 * @param app    The Nest application instance.
 * @param config The validated application configuration.
 */
export function configureApp(app: INestApplication, config: AppConfig) {
  // Add security headers (XSS protection, no-sniff, HSTS, etc.).
  app.use(helmet());
  // Allow cross-origin requests from the configured origins ('*' = everyone).
  app.enableCors({ origin: config.corsOrigins });
  // Prefix every route with e.g. /api so routes become /api/...
  app.setGlobalPrefix(config.apiPrefix);
  // Enable URL versioning (/api/v1/...); routes default to version 1.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Register a global validation pipe for every incoming request.
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that have no validation decorator in the DTO.
      whitelist: true,
      // Reject the request (400) if unknown properties are sent.
      forbidNonWhitelisted: true,
      // Convert plain JSON into DTO class instances (and apply defaults/types).
      transform: true,
    }),
  );
  // Listen for SIGTERM/SIGINT so modules can clean up on shutdown.
  app.enableShutdownHooks();
}
