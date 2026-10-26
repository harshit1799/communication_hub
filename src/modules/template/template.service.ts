/**
 * Templates stored in the database, managed by tenants without deployments.
 *
 *   management   create, version, activate (publish / roll back), archive,
 *                preview: TemplateController (gRPC)
 *   accept time  resolveForSend(): name -> (template id, version), pinned on
 *                the notification so retries render identical content
 *   send time    render(): the pinned version, cached in Redis (versions are
 *                immutable) and compiled once per process (TemplateRenderer)
 *
 * The name -> active version pointer is cached in Redis and deleted on
 * every change, so a publish applies to the very next send.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, REDIS_KEY } from '../../constant/index.js';
import { CursorPage } from '../../database/postgres/base.repository.js';
import {
  ActivateTemplateVersionDto,
  CreateTemplateDto,
  CreateTemplateVersionDto,
  ListTemplatesDto,
  PreviewTemplateDto,
  TemplateContentDto,
} from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { Template, TemplateVersion } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { errorMessage } from '../../utils/appUtils.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { RenderedContent, TemplateData, TemplateRenderer, TemplateSource } from '../../utils/template/template-renderer.js';
import { loadStarterTemplates } from './starter-templates.js';
import { TemplatePointer, TemplateRepository } from './template.repository.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';
// Versions never change: cache them for a day (bounded by Redis memory policy).
const VERSION_CACHE_TTL_SECONDS = 24 * 3600;

/** A cached version: its id is the compile-cache key. */
interface CachedVersion extends TemplateSource {
  id: string;
}

@Injectable()
export class TemplateService {
  private readonly pointerTtl: number;

  constructor(
    private readonly templates: TemplateRepository,
    private readonly renderer: TemplateRenderer,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.pointerTtl = config.getOrThrow<AppConfig>('app').cache.templateTtlSeconds;
  }

  // ---------- Management ----------

  /** Creates the template with version 1 (active). */
  async create(tenantId: string, dto: CreateTemplateDto): Promise<Template> {
    this.validateContent(dto.channel, dto.content);
    try {
      const { template } = await this.templates.createWithFirstVersion(
        { tenantId, channel: dto.channel, name: dto.name, description: dto.description ?? null },
        dto.content,
      );
      await this.invalidate(template);
      return template;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppException(ERROR.TEMPLATE_NAME_TAKEN);
      throw err;
    }
  }

  async get(tenantId: string, id: string): Promise<Template> {
    const template = await this.templates.findForTenant(tenantId, id);
    if (!template) throw new AppException(ERROR.TEMPLATE_NOT_FOUND, undefined, { template: id });
    return template;
  }

  list(tenantId: string, query: ListTemplatesDto): Promise<CursorPage<Template>> {
    return this.templates.list(tenantId, query);
  }

  async listVersions(tenantId: string, id: string): Promise<{ template: Template; versions: TemplateVersion[] }> {
    const template = await this.get(tenantId, id);
    return { template, versions: await this.templates.listVersions(id) };
  }

  /** Publishes new content as version N+1 (active right away if requested). */
  async createVersion(tenantId: string, dto: CreateTemplateVersionDto): Promise<{ template: Template; version: TemplateVersion }> {
    const template = this.writable(await this.get(tenantId, dto.templateId));
    this.validateContent(template.channel, dto.content);
    const result = await this.templates.addVersion(template.id, dto.content, dto.activate);
    await this.invalidate(template);
    return result;
  }

  /** Makes an existing version active: publish a draft or roll back. */
  async activate(tenantId: string, dto: ActivateTemplateVersionDto): Promise<Template> {
    const template = this.writable(await this.get(tenantId, dto.templateId));
    if (!(await this.templates.findVersion(template.id, dto.version))) {
      throw new AppException(ERROR.TEMPLATE_VERSION_NOT_FOUND, undefined, { version: dto.version });
    }
    template.activeVersion = dto.version;
    const saved = await this.templates.save(template);
    await this.invalidate(saved);
    return saved;
  }

  /** Archived templates are rejected for new sends; queued ones still deliver. */
  async archive(tenantId: string, id: string): Promise<Template> {
    const template = await this.get(tenantId, id);
    if (template.archivedAt) return template;
    template.archivedAt = new Date();
    const saved = await this.templates.save(template);
    await this.invalidate(saved);
    return saved;
  }

  /** Renders a version with sample data (nothing is sent). */
  async preview(tenantId: string, dto: PreviewTemplateDto, defaults: TemplateData): Promise<RenderedContent> {
    const template = await this.get(tenantId, dto.templateId);
    const version = dto.version ?? template.activeVersion;
    const source = await this.loadVersion(template.id, version);
    if (!source) throw new AppException(ERROR.TEMPLATE_VERSION_NOT_FOUND, undefined, { version });
    try {
      return this.renderer.render(source.id, source, { ...defaults, ...dto.data });
    } catch (err) {
      throw new AppException(ERROR.TEMPLATE_INVALID, undefined, { reason: errorMessage(err) });
    }
  }

  /** Copies the starter templates into a new tenant (inside its creation transaction). */
  async seedStarterTemplates(tenantId: string, manager: EntityManager): Promise<void> {
    for (const t of loadStarterTemplates()) {
      await this.templates.createWithFirstVersion(
        { tenantId, channel: t.channel, name: t.name, description: t.description },
        { subject: t.subject, body: t.body, html: t.html },
        manager,
      );
    }
  }

  // ---------- Send path ----------

  /**
   * Resolves the template a send refers to and the version to pin. Throws
   * TEMPLATE_NOT_FOUND / TEMPLATE_ARCHIVED / TEMPLATE_VERSION_NOT_FOUND.
   */
  async resolveForSend(
    tenantId: string,
    channel: NotificationChannel,
    name: string,
    version?: number,
  ): Promise<{ templateId: string; version: number }> {
    const pointer = await this.redis.cached<TemplatePointer | null>(
      REDIS_KEY.template(tenantId, channel, name),
      this.pointerTtl,
      () => this.templates.pointer(tenantId, channel, name),
    );
    if (!pointer) throw new AppException(ERROR.TEMPLATE_NOT_FOUND, { channel }, { template: `${channel}/${name}` });
    if (pointer.archived) throw new AppException(ERROR.TEMPLATE_ARCHIVED);
    if (version !== undefined && version !== pointer.activeVersion && !(await this.loadVersion(pointer.templateId, version))) {
      throw new AppException(ERROR.TEMPLATE_VERSION_NOT_FOUND, undefined, { version });
    }
    return { templateId: pointer.templateId, version: version ?? pointer.activeVersion };
  }

  /**
   * Worker side: renders a pinned version. A missing version or a render
   * error can't be fixed by retrying: PermanentDeliveryError. Redis/Postgres
   * errors while loading propagate as transient (retried).
   */
  async render(templateId: string, version: number, data: TemplateData, subjectOverride?: string): Promise<RenderedContent> {
    const source = await this.loadVersion(templateId, version);
    if (!source) throw new PermanentDeliveryError(`Template version ${version} no longer exists`, 'template');
    try {
      return this.renderer.render(source.id, source, data, subjectOverride);
    } catch (err) {
      throw new PermanentDeliveryError(`Template rendering failed: ${errorMessage(err)}`, 'template');
    }
  }

  /** Inline text (request subject/body): throws on broken {{placeholders}}. */
  renderText(text: string, data: TemplateData): string {
    return this.renderer.renderText(text, data);
  }

  // ---------- Helpers ----------

  /** A version's content, via Redis (immutable, so never invalidated). */
  private loadVersion(templateId: string, version: number): Promise<CachedVersion | null> {
    return this.redis.cached<CachedVersion | null>(REDIS_KEY.templateVersion(templateId, version), VERSION_CACHE_TTL_SECONDS, async () => {
      const v = await this.templates.findVersion(templateId, version);
      return v ? { id: v.id, subject: v.subject, body: v.body, html: v.html } : null;
    });
  }

  /**
   * Channel rules for content, then a full compile so syntax errors are
   * rejected before anything is stored.
   */
  private validateContent(channel: NotificationChannel, content: TemplateContentDto) {
    const problems: string[] = [];
    if (channel === NotificationChannel.Email) {
      if (!content.subject) problems.push('email templates need a subject');
      if (!content.html && !content.body) problems.push('email templates need html and/or body');
    } else {
      if (!content.body) problems.push(`${channel} templates need a body`);
      if (content.html) problems.push(`${channel} templates have no html part`);
      if (channel === NotificationChannel.Sms && content.subject) problems.push('sms templates have no subject');
    }
    if (problems.length === 0) {
      try {
        this.renderer.compile(content);
      } catch (err) {
        problems.push(errorMessage(err));
      }
    }
    if (problems.length > 0) throw new AppException(ERROR.TEMPLATE_INVALID, { errors: problems }, { reason: problems[0] });
  }

  private writable(template: Template): Template {
    if (template.archivedAt) throw new AppException(ERROR.TEMPLATE_ARCHIVED);
    return template;
  }

  private invalidate(t: Template): Promise<void> {
    return this.redis.invalidate(REDIS_KEY.template(t.tenantId, t.channel, t.name));
  }
}
