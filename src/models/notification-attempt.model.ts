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
import { Notification } from './notification.model.js';

/** One delivery attempt of a notification (append-only). */
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
  notification?: Notification;

  // 1-based attempt number.
  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'varchar', length: 30 })
  provider: string;

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
