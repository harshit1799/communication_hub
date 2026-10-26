/**
 * communication_hub.v1.TenantAdminService (admin key): tenants and their
 * API keys.
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AdminOnly } from '../../decorator/index.js';
import { CreateApiKeyDto, CreateTenantDto, RevokeApiKeyDto, TenantIdDto, UpdateTenantDto } from '../../dto/index.js';
import { compact, ProtoTimestamp, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { ApiKey, Tenant } from '../../models/index.js';
import { IssuedKey, TenantService } from './tenant.service.js';

const SERVICE = 'TenantAdminService';

const toProtoTenant = (t: Tenant) => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  active: t.isActive,
  settings: compact({ appName: t.settings?.appName }),
  createdAt: Timestamp.encode(t.createdAt),
  updatedAt: Timestamp.encode(t.updatedAt),
});

/** Never exposes the key hash. */
const toProtoKey = (k: ApiKey) =>
  compact({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: Timestamp.encode(k.lastUsedAt),
    expiresAt: Timestamp.encode(k.expiresAt),
    revokedAt: Timestamp.encode(k.revokedAt),
    createdAt: Timestamp.encode(k.createdAt),
  });

const toProtoIssued = ({ apiKey, key }: IssuedKey) => ({ apiKey: toProtoKey(apiKey), key });

@AdminOnly()
@Controller()
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @GrpcMethod(SERVICE, 'CreateTenant')
  async create(@Payload() req: { name?: string; slug?: string; settings?: { appName?: string } }) {
    const { tenant, apiKey } = await this.tenants.create(validateInput(CreateTenantDto, compact(req)));
    return { tenant: toProtoTenant(tenant), apiKey: toProtoIssued(apiKey) };
  }

  @GrpcMethod(SERVICE, 'GetTenant')
  async get(@Payload() req: { id?: string }) {
    return toProtoTenant(await this.tenants.findOne(validateInput(TenantIdDto, req).id));
  }

  @GrpcMethod(SERVICE, 'ListTenants')
  async list() {
    return { tenants: (await this.tenants.findAll()).map(toProtoTenant) };
  }

  @GrpcMethod(SERVICE, 'UpdateTenant')
  async update(@Payload() req: { id?: string; name?: string; active?: boolean; settings?: { appName?: string } }) {
    const dto = validateInput(UpdateTenantDto, compact({ id: req.id, name: req.name, isActive: req.active, settings: req.settings }));
    return toProtoTenant(await this.tenants.update(dto));
  }

  @GrpcMethod(SERVICE, 'CreateApiKey')
  async createApiKey(@Payload() req: { tenantId?: string; name?: string; expiresAt?: ProtoTimestamp }) {
    const dto = validateInput(CreateApiKeyDto, compact({ ...req, expiresAt: Timestamp.decode(req.expiresAt) }));
    return toProtoIssued(await this.tenants.createApiKey(dto));
  }

  @GrpcMethod(SERVICE, 'ListApiKeys')
  async listApiKeys(@Payload() req: { id?: string }) {
    return { apiKeys: (await this.tenants.listApiKeys(validateInput(TenantIdDto, req).id)).map(toProtoKey) };
  }

  @GrpcMethod(SERVICE, 'RevokeApiKey')
  async revokeApiKey(@Payload() req: { tenantId?: string; keyId?: string }) {
    const { tenantId, keyId } = validateInput(RevokeApiKeyDto, req);
    await this.tenants.revokeApiKey(tenantId, keyId);
    return {};
  }
}
