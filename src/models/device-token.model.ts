/**
 * `device_tokens` table: push tokens registered by a tenant's apps, so push
 * notifications can target a user instead of a single device.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DevicePlatform } from '../constant/index.js';

/**
 * A push token registered for one of a tenant's users. A token belongs
 * to at most one user per tenant; re-registering moves it.
 */
@Entity('device_tokens')
@Index('uq_device_tokens_tenant_token', ['tenantId', 'token'], { unique: true })
@Index('idx_device_tokens_tenant_user', ['tenantId', 'userId'], {
  where: 'is_active',
})
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_device_tokens',
  })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  // Tenant's own user id.
  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  userId: string;

  // FCM registration token.
  @Column({ type: 'varchar', length: 500 })
  token: string;

  @Column({ type: 'varchar', length: 10 })
  platform: DevicePlatform;

  // Cleared when FCM reports the token as unregistered/invalid.
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
