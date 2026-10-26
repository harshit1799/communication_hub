/**
 * In-app notifications: the `inbox_messages` table, `notifications.also_push`,
 * and the in-app starter templates for existing tenants.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';
import { loadStarterTemplates } from '../../../modules/template/starter-templates.js';

export class InAppInbox1763000000000 implements MigrationInterface {
  name = 'InAppInbox1763000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "also_push" boolean NOT NULL DEFAULT false`);
    await q.query(`
      CREATE TABLE "inbox_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "user_id" varchar(128) NOT NULL,
        "notification_id" uuid NOT NULL,
        "title" varchar(255),
        "body" text NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "read_at" timestamptz,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "pk_inbox_messages" PRIMARY KEY ("id"),
        CONSTRAINT "uq_inbox_messages_notification" UNIQUE ("notification_id"),
        CONSTRAINT "fk_inbox_messages_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_inbox_messages_notification" FOREIGN KEY ("notification_id")
          REFERENCES "notifications" ("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE INDEX "idx_inbox_messages_user_created" ON "inbox_messages" ("tenant_id", "user_id", "created_at", "id")`,
    );
    await q.query(
      `CREATE INDEX "idx_inbox_messages_user_unread" ON "inbox_messages" ("tenant_id", "user_id") WHERE read_at IS NULL`,
    );
    await q.query(`CREATE INDEX "idx_inbox_messages_expires" ON "inbox_messages" ("expires_at")`);

    for (const t of loadStarterTemplates().filter((s) => s.channel === 'in_app')) {
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "templates" WHERE "channel" = 'in_app'`);
    await q.query(`DROP TABLE "inbox_messages"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "also_push"`);
  }
}
