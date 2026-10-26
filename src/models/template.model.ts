/**
 * `templates` table: a tenant's named message template for one channel.
 * Content lives in immutable `template_versions`; `activeVersion` says which
 * one new sends use, so publishing and rolling back are a single update.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { NotificationChannel } from '../constant/index.js';
import { Tenant } from './tenant.model.js';
import { TemplateVersion } from './template-version.model.js';

@Entity('templates')
@Unique('uq_templates_tenant_channel_name', ['tenantId', 'channel', 'name'])
export class Template {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_templates' })
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'fk_templates_tenant' })
  tenant?: Relation<Tenant>;

  @Column({ type: 'varchar', length: 20 })
  channel: NotificationChannel;

  // What clients send as `template`, e.g. "password-reset".
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  // Version used by sends that don't pin one.
  @Column({ name: 'active_version', type: 'int' })
  activeVersion: number;

  // Highest version number so far (next version = latestVersion + 1).
  @Column({ name: 'latest_version', type: 'int' })
  latestVersion: number;

  // Archived templates are kept (old notifications reference them) but
  // can't be used for new sends.
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @OneToMany(() => TemplateVersion, (v) => v.template)
  versions?: TemplateVersion[];

  // Millisecond precision, like the JS Dates in pagination cursors.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
