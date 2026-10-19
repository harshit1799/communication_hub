/**
 * Data source for the TypeORM CLI (npm run migration:*). The app itself
 * connects through DatabaseModule; this file is only used by the CLI.
 */

// TypeORM decorators need the metadata polyfill.
import 'reflect-metadata';
// The connection class the CLI expects as default export.
import { DataSource } from 'typeorm';
// Builds config from environment variables.
import configuration from '../config/configuration.js';
// Same env checks the app runs at startup.
import { validateEnv } from '../config/env.validation.js';
// Shared connection options.
import { buildDataSourceOptions } from './database.options.js';

// Nest's ConfigModule reads .env for the app; the CLI has to do it itself.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables.
}
// Fail with a clear message (e.g. missing DB_PASSWORD) instead of a pg error.
validateEnv(process.env);

export default new DataSource(
  buildDataSourceOptions(configuration().app.database),
);
