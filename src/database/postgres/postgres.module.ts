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
import { FieldCipher } from '../../utils/crypto/field-cipher.js';
import { PostgresConnectionLogger } from './postgres-connection.logger.js';
import { buildDataSourceOptions } from './postgres.options.js';

/** Configures the TypeORM connection used by every repository. */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      // FieldCipher is injected (not used) so encryption keys are loaded
      // before the first query can hydrate an encrypted column.
      inject: [ConfigService, FieldCipher],
      useFactory: (config: ConfigService, _cipher: FieldCipher) => {
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
