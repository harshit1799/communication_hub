/**
 * `provider_configs` table: which vendor delivers a tenant's messages on a
 * channel, with what credentials, in which order. Read on the send path
 * through the Redis cache (ProviderResolver), never per request from
 * Postgres. Credentials are encrypted (AES-256-GCM, see utils/crypto).
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
import { NotificationChannel, ProviderKind } from '../constant/index.js';
import { ENCRYPTED, encryptedJson } from '../utils/crypto/encrypted.transformer.js';
import type { ProviderLimits } from '../modules/provider/provider-limits.js';
import { Tenant } from './tenant.model.js';

@Entity('provider_configs')
@Unique('uq_provider_configs_tenant_channel_name', ['tenantId', 'channel', 'name'])
@Index('idx_provider_configs_tenant_channel', ['tenantId', 'channel'])
export class ProviderConfig {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_provider_configs' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'fk_provider_configs_tenant' })
  tenant?: Relation<Tenant>;

  @Column({ type: 'varchar', length: 20 })
  channel: NotificationChannel;

  @Column({ type: 'varchar', length: 30 })
  provider: ProviderKind;

  // Unique per tenant + channel, e.g. "ses-primary".
  @Column({ type: 'varchar', length: 100 })
  name: string;

  // Failover order: lower is tried first.
  @Column({ type: 'int', default: 100 })
  priority: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  // Non-secret options (host, port, region, `from`, ...).
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  settings: Record<string, string>;

  // Named From addresses of this provider: { support: "Acme Support <support@acme.com>", ... }.
  // settings.from stays the default; a send picks one of these by name.
  @Column({ name: 'from_addresses', type: 'jsonb', default: () => "'{}'::jsonb" })
  fromAddresses: Record<string, string>;

  // Delivery limits for this provider (retries, rate, concurrency); see provider-limits.ts.
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  limits: ProviderLimits;

  // Secrets (passwords, API keys, service accounts). Encrypted at rest.
  @Column({ type: 'text', transformer: encryptedJson(ENCRYPTED.PROVIDER_CREDENTIALS) })
  credentials: Record<string, string>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
