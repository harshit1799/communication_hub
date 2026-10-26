/**
 * communication_hub.v1.TemplateService (tenant API key).
 */

import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AppConfig } from '../../config/configuration.js';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import {
  ActivateTemplateVersionDto,
  CreateTemplateDto,
  CreateTemplateVersionDto,
  ListTemplatesDto,
  PreviewTemplateDto,
  TemplateIdDto,
} from '../../dto/index.js';
import { ChannelCodec, compact, ProtoStruct, Struct, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { Template, TemplateVersion } from '../../models/index.js';
import { TemplateService } from './template.service.js';

const SERVICE = 'TemplateService';

interface ProtoContent {
  subject?: string;
  body?: string;
  html?: string;
}

const toProtoTemplate = (t: Template) =>
  compact({
    id: t.id,
    channel: ChannelCodec.encode(t.channel),
    name: t.name,
    description: t.description,
    activeVersion: t.activeVersion,
    latestVersion: t.latestVersion,
    archived: t.archivedAt !== null,
    createdAt: Timestamp.encode(t.createdAt),
    updatedAt: Timestamp.encode(t.updatedAt),
  });

const toProtoVersion = (v: TemplateVersion, activeVersion: number) => ({
  templateId: v.templateId,
  version: v.version,
  content: compact({ subject: v.subject, body: v.body, html: v.html }),
  active: v.version === activeVersion,
  createdAt: Timestamp.encode(v.createdAt),
});

@Controller()
export class TemplateController {
  private readonly appName: string;

  constructor(
    private readonly templates: TemplateService,
    config: ConfigService,
  ) {
    this.appName = config.getOrThrow<AppConfig>('app').name;
  }

  @GrpcMethod(SERVICE, 'CreateTemplate')
  async create(@Payload() req: { channel?: string; name?: string; description?: string; content?: ProtoContent }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(CreateTemplateDto, compact({ ...req, channel: ChannelCodec.decode(req.channel), content: req.content ?? {} }));
    return toProtoTemplate(await this.templates.create(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'GetTemplate')
  async get(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    return toProtoTemplate(await this.templates.get(tenant.tenantId, validateInput(TemplateIdDto, req).id));
  }

  @GrpcMethod(SERVICE, 'ListTemplates')
  async list(@Payload() req: { page?: { limit?: number; cursor?: string }; channel?: string; includeArchived?: boolean }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(
      ListTemplatesDto,
      compact({
        limit: req.page?.limit || undefined,
        cursor: req.page?.cursor,
        channel: ChannelCodec.decode(req.channel),
        includeArchived: req.includeArchived ?? false,
      }),
    );
    const { data, nextCursor } = await this.templates.list(tenant.tenantId, dto);
    return { templates: data.map(toProtoTemplate), page: compact({ nextCursor }) };
  }

  @GrpcMethod(SERVICE, 'CreateTemplateVersion')
  async createVersion(@Payload() req: { templateId?: string; content?: ProtoContent; activate?: boolean }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(CreateTemplateVersionDto, compact({ ...req, content: req.content ?? {}, activate: req.activate ?? false }));
    const { template, version } = await this.templates.createVersion(tenant.tenantId, dto);
    return toProtoVersion(version, template.activeVersion);
  }

  @GrpcMethod(SERVICE, 'ListTemplateVersions')
  async listVersions(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    const { template, versions } = await this.templates.listVersions(tenant.tenantId, validateInput(TemplateIdDto, req).id);
    return { versions: versions.map((v) => toProtoVersion(v, template.activeVersion)) };
  }

  @GrpcMethod(SERVICE, 'ActivateTemplateVersion')
  async activate(@Payload() req: { templateId?: string; version?: number }, @CurrentTenant() tenant: TenantContext) {
    return toProtoTemplate(await this.templates.activate(tenant.tenantId, validateInput(ActivateTemplateVersionDto, req)));
  }

  @GrpcMethod(SERVICE, 'ArchiveTemplate')
  async archive(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    return toProtoTemplate(await this.templates.archive(tenant.tenantId, validateInput(TemplateIdDto, req).id));
  }

  @GrpcMethod(SERVICE, 'PreviewTemplate')
  async preview(@Payload() req: { templateId?: string; version?: number; data?: ProtoStruct }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(PreviewTemplateDto, compact({ templateId: req.templateId, version: req.version, data: Struct.decode(req.data) }));
    const defaults = { appName: tenant.settings.appName ?? this.appName, year: new Date().getFullYear() };
    return compact({ ...(await this.templates.preview(tenant.tenantId, dto, defaults)) });
  }
}
