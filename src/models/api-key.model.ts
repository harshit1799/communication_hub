/**
 * `api_keys` table: credentials tenants use to call the API.
 *
 * Only a SHA-256 hash of the key is stored; the raw key is shown once at
 * creation. A tenant can hold several keys so they can be rotated without
 * downtime (create new -> deploy -> revoke old).
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
} from 'typeorm';
import { Tenant } from './tenant.model.js';

/** One API key of a tenant. Valid while not revoked and not expired. */
@Entity('api_keys')
@Index('idx_api_keys_tenant', ['tenantId'])
@Unique('uq_api_keys_key_hash', ['keyHash'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_api_keys' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenant_id',
    foreignKeyConstraintName: 'fk_api_keys_tenant',
  })
  tenant?: Tenant;

  // Label to tell keys apart, e.g. "production backend".
  @Column({ type: 'varchar', length: 100 })
  name: string;

  // First characters of the key, safe to display ("chk_a1b2c3d4").
  @Column({ type: 'varchar', length: 20 })
  prefix: string;

  // Hex SHA-256 of the full key. Keys are random, so no salt is needed.
  @Column({ name: 'key_hash', type: 'char', length: 64 })
  keyHash: string;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
