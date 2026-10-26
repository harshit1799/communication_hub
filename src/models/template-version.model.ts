/**
 * `template_versions` table: immutable content of one template version.
 * Never updated after insert, so a version can be cached forever and a
 * notification renders exactly what it was accepted with, even on retry.
 */

import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { Template } from './template.model.js';

@Entity('template_versions')
@Unique('uq_template_versions_template_version', ['templateId', 'version'])
export class TemplateVersion {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_template_versions' })
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @ManyToOne(() => Template, (t) => t.versions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id', foreignKeyConstraintName: 'fk_template_versions_template' })
  template?: Relation<Template>;

  // 1, 2, 3, ... per template.
  @Column({ type: 'int' })
  version: number;

  // Email subject / push title (Handlebars).
  @Column({ type: 'varchar', length: 255, nullable: true })
  subject: string | null;

  // SMS / push body, or the email text part (Handlebars, not escaped).
  @Column({ type: 'text', nullable: true })
  body: string | null;

  // Email HTML part (Handlebars, {{values}} HTML-escaped).
  @Column({ type: 'text', nullable: true })
  html: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
