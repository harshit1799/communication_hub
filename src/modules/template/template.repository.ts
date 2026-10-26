/**
 * Data access for `templates` and `template_versions`.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { NotificationChannel } from '../../constant/index.js';
import { BaseRepository, CursorPage } from '../../database/postgres/base.repository.js';
import { Template, TemplateVersion } from '../../models/index.js';
import type { TemplateSource } from '../../utils/template/template-renderer.js';

/** What the send path caches for "template <name> on <channel>". */
export interface TemplatePointer {
  templateId: string;
  activeVersion: number;
  archived: boolean;
}

@Injectable()
export class TemplateRepository extends BaseRepository<Template> {
  constructor(
    @InjectRepository(Template) repository: Repository<Template>,
    @InjectRepository(TemplateVersion) private readonly versions: Repository<TemplateVersion>,
  ) {
    super(repository);
  }

  /**
   * Inserts a template with its version 1 in one transaction. Throws a
   * unique violation if (tenant, channel, name) exists.
   */
  createWithFirstVersion(
    input: { tenantId: string; channel: NotificationChannel; name: string; description: string | null },
    content: TemplateSource,
    manager?: EntityManager,
  ): Promise<{ template: Template; version: TemplateVersion }> {
    const work = async (m: EntityManager) => {
      const template = await m.getRepository(Template).save(
        m.getRepository(Template).create({ ...input, activeVersion: 1, latestVersion: 1, archivedAt: null }),
      );
      const version = await m.getRepository(TemplateVersion).save(
        m.getRepository(TemplateVersion).create({ templateId: template.id, version: 1, ...this.parts(content) }),
      );
      return { template, version };
    };
    return manager ? work(manager) : this.transaction(work);
  }

  /**
   * Appends version N+1 (optionally activating it). The template row is
   * locked, so concurrent publishers get consecutive numbers.
   */
  addVersion(templateId: string, content: TemplateSource, activate: boolean): Promise<{ template: Template; version: TemplateVersion }> {
    return this.transaction(async (m) => {
      const templates = m.getRepository(Template);
      const template = await templates.findOne({ where: { id: templateId }, lock: { mode: 'pessimistic_write' } });
      if (!template) throw new Error(`template ${templateId} vanished`);
      template.latestVersion += 1;
      if (activate) template.activeVersion = template.latestVersion;
      await templates.save(template);
      const version = await m
        .getRepository(TemplateVersion)
        .save(m.getRepository(TemplateVersion).create({ templateId, version: template.latestVersion, ...this.parts(content) }));
      return { template, version };
    });
  }

  findForTenant(tenantId: string, id: string): Promise<Template | null> {
    return this.findOne({ tenantId, id });
  }

  /** Send-path lookup (cached by TemplateService). */
  async pointer(tenantId: string, channel: NotificationChannel, name: string): Promise<TemplatePointer | null> {
    const t = await this.findOne({ tenantId, channel, name }, { select: { id: true, activeVersion: true, archivedAt: true } });
    return t ? { templateId: t.id, activeVersion: t.activeVersion, archived: t.archivedAt !== null } : null;
  }

  findVersion(templateId: string, version: number): Promise<TemplateVersion | null> {
    return this.versions.findOneBy({ templateId, version });
  }

  listVersions(templateId: string): Promise<TemplateVersion[]> {
    return this.versions.find({ where: { templateId }, order: { version: 'DESC' } });
  }

  list(tenantId: string, query: { channel?: NotificationChannel; includeArchived: boolean; limit: number; cursor?: string }): Promise<CursorPage<Template>> {
    const qb = this.queryBuilder('t').where('t.tenant_id = :tenantId', { tenantId });
    if (query.channel) qb.andWhere('t.channel = :channel', { channel: query.channel });
    if (!query.includeArchived) qb.andWhere('t.archived_at IS NULL');
    return this.paginateByCursor(qb, 't', query.limit, query.cursor);
  }

  private parts(content: TemplateSource) {
    return { subject: content.subject || null, body: content.body || null, html: content.html || null };
  }
}
