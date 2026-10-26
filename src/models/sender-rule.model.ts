/**
 * `sender_rules` table: picks a sender identity when the request doesn't
 * name one, e.g. "+91 numbers use the DLT-registered sender" or "the
 * invoice template sends from billing@". Evaluated by SenderResolver.
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { NotificationChannel, SenderRuleMatch } from '../constant/index.js';
import { SenderIdentity } from './sender-identity.model.js';
import { Template } from './template.model.js';
import { Tenant } from './tenant.model.js';

@Entity('sender_rules')
@Index('idx_sender_rules_tenant_channel', ['tenantId', 'channel'])
export class SenderRule {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_sender_rules' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'fk_sender_rules_tenant' })
  tenant?: Relation<Tenant>;

  @Column({ type: 'varchar', length: 20 })
  channel: NotificationChannel;

  // Only applies to this template; null = every send on the channel.
  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId: string | null;

  @ManyToOne(() => Template, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id', foreignKeyConstraintName: 'fk_sender_rules_template' })
  template?: Relation<Template>;

  @Column({ name: 'match_type', type: 'varchar', length: 20 })
  matchType: SenderRuleMatch;

  // Prefix ("+91") or domain ("gmail.com"); null for `any`.
  @Column({ name: 'match_value', type: 'varchar', length: 255, nullable: true })
  matchValue: string | null;

  @Column({ name: 'sender_id', type: 'uuid' })
  senderId: string;

  @ManyToOne(() => SenderIdentity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id', foreignKeyConstraintName: 'fk_sender_rules_sender' })
  sender?: Relation<SenderIdentity>;

  // Lower runs first (within template-specific, then general rules).
  @Column({ type: 'int', default: 100 })
  priority: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
