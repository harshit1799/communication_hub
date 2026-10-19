/**
 * Opens the PostgreSQL connection for the whole app and applies any pending
 * migrations on startup.
 */

// Module decorator.
import { Module } from '@nestjs/common';
// Reads the typed configuration.
import { ConfigService } from '@nestjs/config';
// Nest integration for TypeORM.
import { TypeOrmModule } from '@nestjs/typeorm';
// Typed config shape.
import { AppConfig } from '../config/configuration.js';
// Shared connection options.
import { buildDataSourceOptions } from './database.options.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions(config.getOrThrow<AppConfig>('app').database),
        // Bring the schema up to date before the app starts serving requests.
        migrationsRun: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
