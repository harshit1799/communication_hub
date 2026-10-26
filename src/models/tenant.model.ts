/**
 * `tenants` table: one row per white-label client that sends through the hub.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-tenant branding. Senders live in `sender_identities` and providers in
 * `provider_configs` (the former emailFrom/smsFrom settings were migrated).
 */
export interface TenantSettings {
  // Brand name shown in templates as {{appName}} (falls back to APP_NAME).
  appName?: string;
}

/**
 * A white-label client. Owns its API keys, notifications, devices,
 * templates, senders and provider configs (all deleted with it via
 * ON DELETE CASCADE).
 */
@Entity('tenants')
@Unique('uq_tenants_slug', ['slug'])
export class Tenant {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_tenants' })
  id: string;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  // Stable, human-readable identifier, unique across tenants.
  @Column({ type: 'varchar', length: 100 })
  slug: string;

  // Inactive tenants are rejected at authentication.
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  settings: TenantSettings;

  // Millisecond precision, like the JS Dates in pagination cursors.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
