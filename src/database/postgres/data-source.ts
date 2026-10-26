/**
 * Data source for the TypeORM CLI (npm run migration:*). The app itself
 * connects through PostgresModule; this file is only used by the CLI.
 *
 * Uses the same `environment` loader as the app (.env, AWS Secrets Manager
 * outside APP_ENV=local, validation), so migrations run against the same
 * database as the app in every environment.
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { environment } from '../../config/environment.js';
import { configureFieldCipher } from '../../utils/crypto/crypto.module.js';
import { buildDataSourceOptions } from './postgres.options.js';

// Nest's ConfigModule reads .env for the app; the CLI has to do it itself.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables.
}

// Same loader as the app: Secrets Manager outside APP_ENV=local, validation.
const { app } = await environment();
// Encrypted columns (TypeORM transformers) need the cipher outside Nest too.
configureFieldCipher(app.crypto);

export default new DataSource(buildDataSourceOptions(app.database));
