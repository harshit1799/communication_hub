/**
 * `inbox_messages` table: in-app notifications of a tenant's users. Written
 * by the worker for CHANNEL_IN_APP (one row per notification, enforced by a
 * unique notification_id, so retries never duplicate), read and updated
 * through InboxService. Expired rows are purged by the maintenance queue.
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { Notification } from './notification.model.js';
import { Tenant } from './tenant.model.js';

@Entity('inbox_messages')
@Unique('uq_inbox_messages_notification', ['notificationId'])
// The user's inbox, newest first (cursor pagination).
@Index('idx_inbox_messages_user_created', ['tenantId', 'userId', 'createdAt', 'id'])
// Unread count / unread-only lists.
@Index('idx_inbox_messages_user_unread', ['tenantId', 'userId'], { where: 'read_at IS NULL' })
@Index('idx_inbox_messages_expires', ['expiresAt'])
export class InboxMessage {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_inbox_messages' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'fk_inbox_messages_tenant' })
  tenant?: Relation<Tenant>;

  // Tenant's own user id.
  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  userId: string;

  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id', foreignKeyConstraintName: 'fk_inbox_messages_notification' })
  notification?: Relation<Notification>;

  // Rendered title (template subject / request subject).
  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  // Rendered body.
  @Column({ type: 'text' })
  body: string;

  // NotificationInput.metadata (deeplinks, ids, ...).
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, string>;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  // Millisecond precision, like the JS Dates in pagination cursors.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
