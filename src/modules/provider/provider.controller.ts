/**
 * communication_hub.v1.ProviderService (tenant API key): the tenant's own
 * providers, credentials and "From" per channel.
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import { CreateProviderDto, ListProvidersDto, ProviderIdDto, UpdateProviderDto } from '../../dto/index.js';
import { ChannelCodec, compact, fieldsOf, nonEmptyMap, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { ProviderConfig } from '../../models/index.js';
import { ProviderConfigService } from './provider-config.service.js';
import type { ProviderLimits } from './provider-limits.js';

const SERVICE = 'ProviderService';

/** Never includes credential values, only their names. */
export function toProtoProvider(p: ProviderConfig) {
  return compact({
    id: p.id,
    channel: ChannelCodec.encode(p.channel),
    provider: p.provider,
    name: p.name,
    priority: p.priority,
    active: p.isActive,
    settings: p.settings,
    fromAddresses: p.fromAddresses ?? {},
    limits: compact({ ...(p.limits ?? {}) }),
    credentialKeys: Object.keys(p.credentials ?? {}).sort(),
    createdAt: Timestamp.encode(p.createdAt),
    updatedAt: Timestamp.encode(p.updatedAt),
  });
}

interface ProtoCreate {
  channel?: string;
  provider?: string;
  name?: string;
  priority?: number;
  settings?: Record<string, string>;
  credentials?: Record<string, string>;
  fromAddresses?: Record<string, string>;
  limits?: ProviderLimits;
}

@Controller()
export class ProviderController {
  constructor(private readonly providers: ProviderConfigService) {}

  @GrpcMethod(SERVICE, 'CreateProvider')
  async create(@Payload() req: ProtoCreate, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(CreateProviderDto, {
      ...req,
      channel: ChannelCodec.decode(req.channel),
      priority: req.priority ?? 100,
      settings: req.settings ?? {},
      credentials: req.credentials ?? {},
      fromAddresses: req.fromAddresses ?? {},
      limits: fieldsOf(req.limits),
    });
    return toProtoProvider(await this.providers.create(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'ListProviders')
  async list(@Payload() req: { channel?: string }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(ListProvidersDto, compact({ channel: ChannelCodec.decode(req.channel) }));
    return { providers: (await this.providers.list(tenant.tenantId, dto.channel)).map(toProtoProvider) };
  }

  @GrpcMethod(SERVICE, 'GetProvider')
  async get(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    return toProtoProvider(await this.providers.get(tenant.tenantId, validateInput(ProviderIdDto, req).id));
  }

  @GrpcMethod(SERVICE, 'UpdateProvider')
  async update(@Payload() req: Omit<ProtoCreate, 'channel' | 'provider'> & { id?: string; active?: boolean }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(
      UpdateProviderDto,
      compact({
        ...req,
        settings: nonEmptyMap(req.settings),
        credentials: nonEmptyMap(req.credentials),
        fromAddresses: nonEmptyMap(req.fromAddresses),
        limits: req.limits ? fieldsOf(req.limits) : undefined,
      }),
    );
    return toProtoProvider(await this.providers.update(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'ListFromAddresses')
  async fromAddresses(@Payload() req: { channel?: string }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(ListProvidersDto, compact({ channel: ChannelCodec.decode(req.channel) }));
    const list = await this.providers.fromAddresses(tenant.tenantId, dto.channel);
    return {
      fromAddresses: list.map((a) =>
        compact({ ...a, name: a.name ?? undefined, channel: ChannelCodec.encode(a.channel) }),
      ),
    };
  }

  @GrpcMethod(SERVICE, 'DeleteProvider')
  async remove(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    await this.providers.remove(tenant.tenantId, validateInput(ProviderIdDto, req).id);
    return {};
  }
}
