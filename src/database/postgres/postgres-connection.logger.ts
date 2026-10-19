/**
 * Logs the PostgreSQL connection once TypeORM has connected (and applied
 * migrations), and when it is closed on shutdown. Connection failures are
 * logged by TypeORM itself, which retries before giving up.
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppConfig, DatabaseConfig } from '../../config/configuration.js';
import { errorMessage } from '../../utils/appUtils.js';

@Injectable()
export class PostgresConnectionLogger implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PostgreSQL');
  private readonly db: DatabaseConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.db = config.getOrThrow<AppConfig>('app').database;
  }

  /** Logs where we are connected, the server version and applied migrations. */
  async onApplicationBootstrap() {
    const target = `${this.db.host}:${this.db.port}/${this.db.name}`;
    try {
      const [{ server_version: version }] = (await this.dataSource.query('SHOW server_version')) as {
        server_version: string;
      }[];
      const migrations = (await this.dataSource.query('SELECT name FROM migrations ORDER BY id')) as { name: string }[];
      this.logger.log(
        `Connected to ${target} (PostgreSQL ${version}, pool ${this.db.poolSize}, ` +
          `ssl ${this.db.ssl ? 'on' : 'off'}, ${migrations.length} migrations applied, latest ${migrations.at(-1)?.name ?? 'none'})`,
      );
    } catch (err) {
      // Connected (TypeORM succeeded), but the details query failed.
      this.logger.log(`Connected to ${target}`);
      this.logger.warn(`Could not read server details: ${errorMessage(err)}`);
    }
  }

  /** TypeORM closes the pool itself; this records that it happens. */
  onApplicationShutdown() {
    this.logger.log(`Closing connection to ${this.db.host}:${this.db.port}/${this.db.name}`);
  }
}
