/**
 * PostgreSQL connection options, shared by the Nest app (postgres.module.ts)
 * and the TypeORM CLI (data-source.ts) so both connect the same way.
 */

import { DataSourceOptions } from 'typeorm';
import { DatabaseConfig } from '../../config/configuration.js';
import { ENTITIES } from '../../models/index.js';
import { MIGRATIONS } from './migrations/index.js';

/** Builds TypeORM options from the typed database config. */
export function buildDataSourceOptions(db: DatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.name,
    ssl: db.ssl,
    logging: db.logging,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    // Never let TypeORM change the schema on its own; migrations do that.
    synchronize: false,
    // Applied as a single unit so a failed deploy leaves no half schema.
    migrationsTransactionMode: 'all',
    // node-postgres pool settings.
    extra: {
      max: db.poolSize,
      // Fail fast instead of hanging when the pool is exhausted.
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      // Kill runaway queries rather than holding connections forever.
      statement_timeout: 15000,
    },
  };
}
