/**
 * `notifications` table: one row per message a tenant asked us to deliver.
 * It is the source of truth for status; the queue only carries the id.
 *
 * `recipient` and `data` (template values: names, OTP codes, ...) are
 * encrypted at rest; `recipient_hash` is a keyed blind index used to
 * filter by recipient without decrypting.
 */

import {
  Column,
  CreateDateColumn,
  Check,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '../constant/index.js';
import { ENCRYPTED, encryptedJson, encryptedString } from '../utils/crypto/encrypted.transformer.js';
import { NotificationAttempt } from './notification-attempt.model.js';
import { SenderIdentity } from './sender-identity.model.js';
import { Template } from './template.model.js';
import { Tenant } from './tenant.model.js';

@Entity('notifications')
@Check('chk_notifications_target', 'recipient IS NOT NULL OR user_id IS NOT NULL')
// Listing: "this tenant's notifications, newest first" (cursor pagination).
@Index('idx_notifications_tenant_created', ['tenantId', 'createdAt', 'id'])
// Idempotency (partial unique index, created in the migration).
@Index('uq_notifications_tenant_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: 'idempotency_key IS NOT NULL',
})
// Sweeper: finds in-flight rows that haven't moved for a while.
@Index('idx_notifications_in_flight', ['updatedAt'], {
  where: "status IN ('queued', 'processing', 'retrying')",
})
// Filter by recipient (the column itself is encrypted).
@Index('idx_notifications_tenant_recipient_hash', ['tenantId', 'recipientHash'], {
  where: 'recipient_hash IS NOT NULL',
})
export class Notification {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_notifications',
  })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenant_id',
    foreignKeyConstraintName: 'fk_notifications_tenant',
  })
  tenant?: Relation<Tenant>;

  // Text (not a Postgres enum) so adding a channel needs no migration.
  @Column({ type: 'varchar', length: 20 })
  channel: NotificationChannel;

  // Email address, phone number or device token. Null for push-to-user.
  // Encrypted at rest; plaintext in memory.
  @Column({ type: 'text', nullable: true, transformer: encryptedString(ENCRYPTED.NOTIFICATION_RECIPIENT) })
  recipient: string | null;

  // HMAC of the normalised recipient, scoped by tenant (FieldCipher.blindIndex).
  @Column({ name: 'recipient_hash', type: 'char', length: 64, nullable: true })
  recipientHash: string | null;

  // Tenant's own user id; push fans out to all of this user's devices.
  @Column({ name: 'user_id', type: 'varchar', length: 128, nullable: true })
  userId: string | null;

  // Raw subject / push title; may contain {{placeholders}}.
  @Column({ type: 'varchar', length: 255, nullable: true })
  subject: string | null;

  // Raw plain-text content; may contain {{placeholders}}.
  @Column({ type: 'text', nullable: true })
  body: string | null;

  // Template name as requested (kept for display if the template is deleted).
  @Column({ type: 'varchar', length: 100, nullable: true })
  template: string | null;

  // Template and version resolved at accept time: retries render the same
  // content even if a new version is activated meanwhile.
  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId: string | null;

  @ManyToOne(() => Template, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'template_id', foreignKeyConstraintName: 'fk_notifications_template' })
  templateRef?: Relation<Template>;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  // Values for the template placeholders. Encrypted JSON.
  @Column({ type: 'text', nullable: true, transformer: encryptedJson(ENCRYPTED.NOTIFICATION_DATA) })
  data: Record<string, unknown> | null;

  // Sender explicitly requested by the client (null = rules / default).
  @Column({ name: 'sender_id', type: 'uuid', nullable: true })
  senderId: string | null;

  // In-app only: also show a visible push (default: silent sync signal).
  @Column({ name: 'also_push', type: 'boolean', default: false })
  alsoPush: boolean;

  @ManyToOne(() => SenderIdentity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sender_id', foreignKeyConstraintName: 'fk_notifications_sender' })
  sender?: Relation<SenderIdentity>;

  // Client references; for push also delivered as the FCM data payload.
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, string> | null;

  @Column({ type: 'varchar', length: 20, default: NotificationStatus.Queued })
  status: NotificationStatus;

  @Column({ type: 'varchar', length: 10, default: NotificationPriority.Normal })
  priority: NotificationPriority;

  // Client-supplied key; a repeated request returns the original row.
  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey: string | null;

  // Delivery attempts made so far.
  @Column({ type: 'int', default: 0 })
  attempts: number;

  // Vendor that delivered (or last tried), e.g. "ses", "twilio", "fcm".
  @Column({ type: 'varchar', length: 30, nullable: true })
  provider: string | null;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId: string | null;

  // Last error message.
  @Column({ type: 'text', nullable: true })
  error: string | null;

  // Deliver no earlier than this time (null = immediately).
  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @OneToMany(() => NotificationAttempt, (a) => a.notification)
  attemptLog?: Relation<NotificationAttempt[]>;

  // Millisecond precision, like the JS Dates in pagination cursors.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
