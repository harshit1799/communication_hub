/**
 * Simplification: senders and sender rules are removed. The "From" is a
 * provider setting (provider_configs.settings.from), optionally overridden
 * per notification (notifications.from_address).
 *
 *   1. each tenant's default sender becomes settings.from of its provider
 *      configs on that channel that don't have one yet
 *   2. notifications that asked for a sender keep its value in from_address
 *   3. sender_rules, sender_identities and notifications.sender_id are dropped
 *
 * down() restores the empty tables and column (the data is not recreated).
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderFromInsteadOfSenders1764000000000 implements MigrationInterface {
  name = 'ProviderFromInsteadOfSenders1764000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "from_address" varchar(255)`);
    await q.query(
      `UPDATE "provider_configs" p
          SET "settings" = p."settings" || jsonb_build_object('from', s."value")
         FROM "sender_identities" s
        WHERE s."tenant_id" = p."tenant_id" AND s."channel" = p."channel"
          AND s."is_default" AND s."is_active" AND NOT (p."settings" ? 'from')`,
    );
    await q.query(
      `UPDATE "notifications" n SET "from_address" = s."value"
         FROM "sender_identities" s WHERE n."sender_id" = s."id"`,
    );
    await q.query(`ALTER TABLE "notifications" DROP CONSTRAINT "fk_notifications_sender", DROP COLUMN "sender_id"`);
    await q.query(`DROP TABLE "sender_rules"`);
    await q.query(`DROP TABLE "sender_identities"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sender_identities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "value" varchar(255) NOT NULL,
        "label" varchar(100),
        "provider_config_id" uuid,
        "is_default" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_sender_identities" PRIMARY KEY ("id"),
        CONSTRAINT "uq_sender_identities_tenant_channel_value" UNIQUE ("tenant_id", "channel", "value"),
        CONSTRAINT "fk_sender_identities_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_identities_provider_config" FOREIGN KEY ("provider_config_id")
          REFERENCES "provider_configs" ("id") ON DELETE SET NULL
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_sender_identities_default" ON "sender_identities" ("tenant_id", "channel") WHERE is_default`);
    await q.query(`
      CREATE TABLE "sender_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "template_id" uuid,
        "match_type" varchar(20) NOT NULL,
        "match_value" varchar(255),
        "sender_id" uuid NOT NULL,
        "priority" int NOT NULL DEFAULT 100,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_sender_rules" PRIMARY KEY ("id"),
        CONSTRAINT "fk_sender_rules_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_rules_template" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_rules_sender" FOREIGN KEY ("sender_id") REFERENCES "sender_identities" ("id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE INDEX "idx_sender_rules_tenant_channel" ON "sender_rules" ("tenant_id", "channel")`);
    await q.query(`
      ALTER TABLE "notifications"
        ADD COLUMN "sender_id" uuid,
        ADD CONSTRAINT "fk_notifications_sender" FOREIGN KEY ("sender_id") REFERENCES "sender_identities" ("id") ON DELETE SET NULL`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "from_address"`);
  }
}
