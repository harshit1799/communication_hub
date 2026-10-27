/**
 * Per-provider delivery limits (retries, rate, concurrency) replacing the
 * platform env defaults for messages the provider delivers.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderLimits1766000000000 implements MigrationInterface {
  name = 'ProviderLimits1766000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "provider_configs" ADD COLUMN "limits" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "provider_configs" DROP COLUMN "limits"`);
  }
}
