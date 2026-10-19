/**
 * Initial schema: tenants, API keys, notifications, delivery attempts and
 * device tokens. Requires PostgreSQL 13+ (gen_random_uuid is built in).
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the five tables with their keys, foreign keys and indexes.
 * Constraint names match the entity decorators, so later
 * migration:generate runs produce no spurious renames.
 */
export class InitSchema1761000000000 implements MigrationInterface {
  name = 'InitSchema1761000000000';

  /** Applies the schema. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar(150) NOT NULL,
        "slug" varchar(100) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenants" PRIMARY KEY ("id"),
        CONSTRAINT "uq_tenants_slug" UNIQUE ("slug")
      )`);

    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "prefix" varchar(20) NOT NULL,
        "key_hash" char(64) NOT NULL,
        "last_used_at" timestamptz,
        "expires_at" timestamptz,
        "revoked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "uq_api_keys_key_hash" UNIQUE ("key_hash"),
        CONSTRAINT "fk_api_keys_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_tenant" ON "api_keys" ("tenant_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "recipient" varchar(500),
        "user_id" varchar(128),
        "subject" varchar(255),
        "body" text,
        "template" varchar(100),
        "data" jsonb,
        "metadata" jsonb,
        "status" varchar(20) NOT NULL DEFAULT 'queued',
        "priority" varchar(10) NOT NULL DEFAULT 'normal',
        "idempotency_key" varchar(255),
        "attempts" int NOT NULL DEFAULT 0,
        "provider" varchar(30),
        "provider_message_id" varchar(255),
        "error" text,
        "scheduled_at" timestamptz,
        "sent_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notifications_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_notifications_target"
          CHECK ("recipient" IS NOT NULL OR "user_id" IS NOT NULL)
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_tenant_created" ON "notifications" ("tenant_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_notifications_tenant_idempotency" ON "notifications" ("tenant_id", "idempotency_key") WHERE idempotency_key IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_in_flight" ON "notifications" ("updated_at") WHERE status IN ('queued', 'processing', 'retrying')`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_attempts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "notification_id" uuid NOT NULL,
        "attempt" int NOT NULL,
        "provider" varchar(30) NOT NULL,
        "success" boolean NOT NULL,
        "provider_message_id" varchar(255),
        "error" text,
        "permanent" boolean NOT NULL DEFAULT false,
        "duration_ms" int NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_attempts_notification" FOREIGN KEY ("notification_id")
          REFERENCES "notifications" ("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_notification_attempts_notification" ON "notification_attempts" ("notification_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "device_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "user_id" varchar(128) NOT NULL,
        "token" varchar(500) NOT NULL,
        "platform" varchar(10) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_seen_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_device_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "fk_device_tokens_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_device_tokens_tenant_token" ON "device_tokens" ("tenant_id", "token")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_tokens_tenant_user" ON "device_tokens" ("tenant_id", "user_id") WHERE is_active`,
    );
  }

  /** Drops the schema in reverse dependency order. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "device_tokens"`);
    await queryRunner.query(`DROP TABLE "notification_attempts"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
  }
}
