/**
 * Templates in the database, multiple senders, per-tenant providers and
 * encrypted recipient data.
 *
 *   1. new tables: provider_configs, templates, template_versions,
 *      sender_identities, sender_rules
 *   2. notifications: recipient -> encrypted text + recipient_hash (blind
 *      index), data -> encrypted text, template_id / template_version /
 *      sender_id; notification_attempts.sender
 *   3. created_at of cursor-paginated tables (tenants, notifications,
 *      templates) at millisecond precision: cursors carry a JS Date (ms),
 *      and microsecond timestamps made pages skip rows created within the
 *      same millisecond. (Rewrites those tables; plan it for large ones.)
 *   4. data: tenants' settings.emailFrom / smsFrom become their default
 *      sender identities; every tenant gets the starter templates;
 *      existing recipients and data are encrypted in place
 *
 * Needs ENCRYPTION_KEYS / BLIND_INDEX_KEY (read from the environment, which
 * the app and the CLI have loaded and validated before migrating).
 *
 * The backfill runs inside the migration transaction in batches. That is
 * fine up to a few million rows; for much larger tables, deploy the schema
 * part first and backfill with a separate job.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';
import { loadStarterTemplates } from '../../../modules/template/starter-templates.js';
import { FieldCipher, parseCipherKeys } from '../../../utils/crypto/field-cipher.js';
import { ENCRYPTED } from '../../../utils/crypto/encrypted.transformer.js';
import { normaliseRecipient } from '../../../utils/crypto/recipient.js';

const BATCH = 1000;

/** The cipher from the environment (the migration can't use DI). */
function cipherFromEnv(): FieldCipher {
  return new FieldCipher(
    parseCipherKeys({
      keys: process.env.ENCRYPTION_KEYS,
      activeKeyId: process.env.ENCRYPTION_ACTIVE_KEY,
      blindIndexKey: process.env.BLIND_INDEX_KEY,
    }),
  );
}

export class TemplatesSendersProviders1762000000000 implements MigrationInterface {
  name = 'TemplatesSendersProviders1762000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createTables(queryRunner);
    await this.alterNotifications(queryRunner);
    for (const table of ['tenants', 'notifications', 'templates']) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "created_at" TYPE timestamptz(3)`);
    }
    await this.migrateTenantSenders(queryRunner);
    await this.seedStarterTemplates(queryRunner);
    await this.encryptNotifications(queryRunner, cipherFromEnv());
  }

  private async createTables(q: QueryRunner) {
    await q.query(`
      CREATE TABLE "provider_configs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "provider" varchar(30) NOT NULL,
        "name" varchar(100) NOT NULL,
        "priority" int NOT NULL DEFAULT 100,
        "is_active" boolean NOT NULL DEFAULT true,
        "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "credentials" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_provider_configs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_provider_configs_tenant_channel_name" UNIQUE ("tenant_id", "channel", "name"),
        CONSTRAINT "fk_provider_configs_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE INDEX "idx_provider_configs_tenant_channel" ON "provider_configs" ("tenant_id", "channel")`);

    await q.query(`
      CREATE TABLE "templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" varchar(255),
        "active_version" int NOT NULL,
        "latest_version" int NOT NULL,
        "archived_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_templates" PRIMARY KEY ("id"),
        CONSTRAINT "uq_templates_tenant_channel_name" UNIQUE ("tenant_id", "channel", "name"),
        CONSTRAINT "fk_templates_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE
      )`);

    await q.query(`
      CREATE TABLE "template_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "template_id" uuid NOT NULL,
        "version" int NOT NULL,
        "subject" varchar(255),
        "body" text,
        "html" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_template_versions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_template_versions_template_version" UNIQUE ("template_id", "version"),
        CONSTRAINT "fk_template_versions_template" FOREIGN KEY ("template_id")
          REFERENCES "templates" ("id") ON DELETE CASCADE
      )`);

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
        CONSTRAINT "fk_sender_identities_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_identities_provider_config" FOREIGN KEY ("provider_config_id")
          REFERENCES "provider_configs" ("id") ON DELETE SET NULL
      )`);
    // At most one default sender per tenant and channel.
    await q.query(
      `CREATE UNIQUE INDEX "uq_sender_identities_default" ON "sender_identities" ("tenant_id", "channel") WHERE is_default`,
    );

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
        CONSTRAINT "fk_sender_rules_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_rules_template" FOREIGN KEY ("template_id")
          REFERENCES "templates" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_sender_rules_sender" FOREIGN KEY ("sender_id")
          REFERENCES "sender_identities" ("id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE INDEX "idx_sender_rules_tenant_channel" ON "sender_rules" ("tenant_id", "channel")`);
  }

  private async alterNotifications(q: QueryRunner) {
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "recipient" TYPE text`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "data" TYPE text USING "data"::text`);
    await q.query(`
      ALTER TABLE "notifications"
        ADD COLUMN "recipient_hash" char(64),
        ADD COLUMN "template_id" uuid,
        ADD COLUMN "template_version" int,
        ADD COLUMN "sender_id" uuid,
        ADD CONSTRAINT "fk_notifications_template" FOREIGN KEY ("template_id")
          REFERENCES "templates" ("id") ON DELETE SET NULL,
        ADD CONSTRAINT "fk_notifications_sender" FOREIGN KEY ("sender_id")
          REFERENCES "sender_identities" ("id") ON DELETE SET NULL`);
    await q.query(
      `CREATE INDEX "idx_notifications_tenant_recipient_hash" ON "notifications" ("tenant_id", "recipient_hash") WHERE recipient_hash IS NOT NULL`,
    );
    await q.query(`ALTER TABLE "notification_attempts" ADD COLUMN "sender" varchar(255)`);
  }

  /** settings.emailFrom / smsFrom -> default sender identities; keys removed. */
  private async migrateTenantSenders(q: QueryRunner) {
    for (const [key, channel] of [
      ['emailFrom', 'email'],
      ['smsFrom', 'sms'],
    ]) {
      await q.query(
        `INSERT INTO "sender_identities" ("tenant_id", "channel", "value", "label", "is_default")
         SELECT "id", $1, "settings"->>$2, 'migrated from tenant settings', true
           FROM "tenants" WHERE coalesce("settings"->>$2, '') <> ''`,
        [channel, key],
      );
    }
    await q.query(`UPDATE "tenants" SET "settings" = "settings" - 'emailFrom' - 'smsFrom'`);
  }

  /** Gives every existing tenant the starter templates (version 1, active). */
  private async seedStarterTemplates(q: QueryRunner) {
    // Channels of that time only (later migrations seed newer channels).
    for (const t of loadStarterTemplates().filter((s) => ['email', 'sms', 'push'].includes(s.channel))) {
      await q.query(
        `WITH created AS (
           INSERT INTO "templates" ("tenant_id", "channel", "name", "description", "active_version", "latest_version")
           SELECT "id", $1, $2, $3, 1, 1 FROM "tenants"
           ON CONFLICT DO NOTHING
           RETURNING "id")
         INSERT INTO "template_versions" ("template_id", "version", "subject", "body", "html")
         SELECT "id", 1, $4, $5, $6 FROM created`,
        [t.channel, t.name, t.description, t.subject, t.body, t.html],
      );
    }
    // Link existing notifications to the template they named.
    await q.query(
      `UPDATE "notifications" n SET "template_id" = t."id", "template_version" = t."active_version"
         FROM "templates" t
        WHERE n."template" IS NOT NULL AND t."tenant_id" = n."tenant_id"
          AND t."channel" = n."channel" AND t."name" = n."template"`,
    );
  }

  /** Encrypts existing recipients/data in batches and fills recipient_hash. */
  private async encryptNotifications(q: QueryRunner, cipher: FieldCipher) {
    let lastId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = (await q.query(
        `SELECT "id", "tenant_id", "channel", "recipient", "data" FROM "notifications"
          WHERE "id" > $1 AND ("recipient" IS NOT NULL OR "data" IS NOT NULL)
          ORDER BY "id" LIMIT $2`,
        [lastId, BATCH],
      )) as { id: string; tenant_id: string; channel: string; recipient: string | null; data: string | null }[];
      if (rows.length === 0) return;
      for (const r of rows) {
        const plain = (v: string | null) => v !== null && !FieldCipher.isEncrypted(v);
        await q.query(
          `UPDATE "notifications" SET "recipient" = $2, "recipient_hash" = $3, "data" = $4 WHERE "id" = $1`,
          [
            r.id,
            plain(r.recipient) ? cipher.encrypt(r.recipient!, ENCRYPTED.NOTIFICATION_RECIPIENT) : r.recipient,
            r.recipient === null || !plain(r.recipient)
              ? null
              : cipher.blindIndex(r.tenant_id, normaliseRecipient(r.channel, r.recipient)),
            plain(r.data) ? cipher.encrypt(r.data!, ENCRYPTED.NOTIFICATION_DATA) : r.data,
          ],
        );
      }
      lastId = rows.at(-1)!.id;
    }
  }

  /** Decrypts back to plaintext and drops the new schema. */
  public async down(q: QueryRunner): Promise<void> {
    const cipher = cipherFromEnv();
    const rows = (await q.query(
      `SELECT "id", "recipient", "data" FROM "notifications" WHERE "recipient" IS NOT NULL OR "data" IS NOT NULL`,
    )) as { id: string; recipient: string | null; data: string | null }[];
    for (const r of rows) {
      const open = (v: string | null, ctx: string) => (v !== null && FieldCipher.isEncrypted(v) ? cipher.decrypt(v, ctx) : v);
      await q.query(`UPDATE "notifications" SET "recipient" = $2, "data" = $3 WHERE "id" = $1`, [
        r.id,
        open(r.recipient, ENCRYPTED.NOTIFICATION_RECIPIENT),
        open(r.data, ENCRYPTED.NOTIFICATION_DATA),
      ]);
    }
    // Restore default senders into tenant settings.
    for (const [key, channel] of [
      ['emailFrom', 'email'],
      ['smsFrom', 'sms'],
    ]) {
      await q.query(
        `UPDATE "tenants" t SET "settings" = t."settings" || jsonb_build_object($1::text, s."value")
           FROM "sender_identities" s
          WHERE s."tenant_id" = t."id" AND s."channel" = $2 AND s."is_default"`,
        [key, channel],
      );
    }
    await q.query(`ALTER TABLE "notification_attempts" DROP COLUMN "sender"`);
    for (const table of ['tenants', 'notifications']) {
      await q.query(`ALTER TABLE "${table}" ALTER COLUMN "created_at" TYPE timestamptz`);
    }
    await q.query(`DROP INDEX "idx_notifications_tenant_recipient_hash"`);
    await q.query(`
      ALTER TABLE "notifications"
        DROP CONSTRAINT "fk_notifications_sender",
        DROP CONSTRAINT "fk_notifications_template",
        DROP COLUMN "sender_id",
        DROP COLUMN "template_version",
        DROP COLUMN "template_id",
        DROP COLUMN "recipient_hash"`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "data" TYPE jsonb USING "data"::jsonb`);
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "recipient" TYPE varchar(500)`);
    await q.query(`DROP TABLE "sender_rules"`);
    await q.query(`DROP TABLE "sender_identities"`);
    await q.query(`DROP TABLE "template_versions"`);
    await q.query(`DROP TABLE "templates"`);
    await q.query(`DROP TABLE "provider_configs"`);
  }
}
