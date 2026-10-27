/**
 * Named From addresses per provider (provider_configs.from_addresses), and
 * which provider config / address delivered each notification
 * (notifications.sent_from / provider_name, notification_attempts.provider_name /
 * provider_config_id).
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class NamedFromAddresses1765000000000 implements MigrationInterface {
  name = 'NamedFromAddresses1765000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "provider_configs" ADD COLUMN "from_addresses" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "sent_from" varchar(255), ADD COLUMN "provider_name" varchar(100)`);
    await q.query(
      `ALTER TABLE "notification_attempts" ADD COLUMN "provider_name" varchar(100), ADD COLUMN "provider_config_id" varchar(64)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notification_attempts" DROP COLUMN "provider_config_id", DROP COLUMN "provider_name"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "provider_name", DROP COLUMN "sent_from"`);
    await q.query(`ALTER TABLE "provider_configs" DROP COLUMN "from_addresses"`);
  }
}
