/**
 * `notification_attempts` table: an audit row for every delivery attempt,
 * successful or not. Answers "what exactly happened to this message?".
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { Notification } from './notification.model.js';

/**
 * One delivery attempt of a notification (append-only). With provider
 * failover, one attempt number has a row per provider tried.
 */
@Entity('notification_attempts')
@Index('idx_notification_attempts_notification', ['notificationId'])
export class NotificationAttempt {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_notification_attempts',
  })
  id: string;

  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId: string;

  @ManyToOne(() => Notification, (n) => n.attemptLog, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'notification_id',
    foreignKeyConstraintName: 'fk_notification_attempts_notification',
  })
  notification?: Relation<Notification>;

  // 1-based attempt number.
  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'varchar', length: 30 })
  provider: string;

  // Provider config used: its name ("smtp-main") and id ("platform:email" for the platform default).
  @Column({ name: 'provider_name', type: 'varchar', length: 100, nullable: true })
  providerName: string | null;

  @Column({ name: 'provider_config_id', type: 'varchar', length: 64, nullable: true })
  providerConfigId: string | null;

  // "From" used (email address / SMS sender id), null when none applied.
  @Column({ type: 'varchar', length: 255, nullable: true })
  sender: string | null;

  @Column({ type: 'boolean' })
  success: boolean;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  // Whether the error was permanent (no further retries).
  @Column({ type: 'boolean', default: false })
  permanent: boolean;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
