/**
 * `sender_identities` table: the "From" values a tenant may send with: email
 * addresses and SMS sender ids / numbers. Any number per channel; at most
 * one default per channel (partial unique index in the migration).
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { NotificationChannel } from '../constant/index.js';
import { ProviderConfig } from './provider-config.model.js';
import { Tenant } from './tenant.model.js';

@Entity('sender_identities')
@Unique('uq_sender_identities_tenant_channel_value', ['tenantId', 'channel', 'value'])
@Index('uq_sender_identities_default', ['tenantId', 'channel'], { unique: true, where: 'is_default' })
export class SenderIdentity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_sender_identities' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'fk_sender_identities_tenant' })
  tenant?: Relation<Tenant>;

  // email | sms
  @Column({ type: 'varchar', length: 20 })
  channel: NotificationChannel;

  // "Acme <no-reply@acme.com>", "+14155550100" or "ACME".
  @Column({ type: 'varchar', length: 255 })
  value: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  label: string | null;

  // Pin to one provider config (e.g. a number owned by one Twilio account).
  @Column({ name: 'provider_config_id', type: 'uuid', nullable: true })
  providerConfigId: string | null;

  @ManyToOne(() => ProviderConfig, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'provider_config_id', foreignKeyConstraintName: 'fk_sender_identities_provider_config' })
  providerConfig?: Relation<ProviderConfig>;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
