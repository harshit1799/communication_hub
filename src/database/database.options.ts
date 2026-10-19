/**
 * PostgreSQL connection options, shared by the Nest app (database.module.ts)
 * and the TypeORM CLI (data-source.ts) so both connect the same way.
 */

// TypeORM's options type for a Postgres connection.
import { DataSourceOptions } from 'typeorm';
// Typed database settings.
import { DatabaseConfig } from '../config/configuration.js';
// Every entity (table) in the app.
import { Notification } from '../modules/notifications/entities/notification.entity.js';
// Every migration, oldest first.

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
    // Add new entities here.
    entities: [Notification],
    // Never let TypeORM change the schema on its own; migrations do that.
    synchronize: false,
  };
}
