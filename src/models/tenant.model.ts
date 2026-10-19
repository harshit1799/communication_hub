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

/** Per-tenant branding and sender overrides. All optional. */
export interface TenantSettings {
  // Brand name shown in templates (falls back to APP_NAME).
  appName?: string;
  // "From" address for emails (falls back to MAIL_FROM).
  emailFrom?: string;
  // Sender number / alphanumeric id for SMS (falls back to provider default).
  smsFrom?: string;
}

/**
 * A white-label client. Owns its API keys, notifications and devices
 * (all deleted with it via ON DELETE CASCADE).
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
