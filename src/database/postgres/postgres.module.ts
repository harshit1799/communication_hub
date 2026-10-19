/**
 * Opens the PostgreSQL connection for the whole app. Pending migrations are
 * applied on startup by API processes only, so a fleet of workers booting
 * at the same time doesn't race to migrate.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../../config/configuration.js';
import { AppRole } from '../../constant/index.js';
import { PostgresConnectionLogger } from './postgres-connection.logger.js';
import { buildDataSourceOptions } from './postgres.options.js';

/** Configures the TypeORM connection used by every repository. */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.getOrThrow<AppConfig>('app');
        return {
          ...buildDataSourceOptions(app.database),
          migrationsRun: app.role !== AppRole.Worker,
        };
      },
    }),
  ],
  providers: [PostgresConnectionLogger],
})
export class PostgresModule {}
