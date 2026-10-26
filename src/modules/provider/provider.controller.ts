/**
 * communication_hub.v1.ProviderAdminService (admin key).
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AdminOnly } from '../../decorator/index.js';
import { CreateProviderConfigDto, ListProviderConfigsDto, ProviderConfigRefDto, UpdateProviderConfigDto } from '../../dto/index.js';
import { ChannelCodec, compact, nonEmptyMap, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { ProviderConfig } from '../../models/index.js';
import { ProviderConfigService } from './provider-config.service.js';

const SERVICE = 'ProviderAdminService';

/** Never includes credential values, only their names. */
export function toProtoProvider(p: ProviderConfig) {
  return compact({
    id: p.id,
    tenantId: p.tenantId,
    channel: ChannelCodec.encode(p.channel),
    provider: p.provider,
    name: p.name,
    priority: p.priority,
    active: p.isActive,
    settings: p.settings,
    credentialKeys: Object.keys(p.credentials ?? {}).sort(),
    createdAt: Timestamp.encode(p.createdAt),
    updatedAt: Timestamp.encode(p.updatedAt),
  });
}

interface ProtoCreate {
  tenantId?: string;
  channel?: string;
  provider?: string;
  name?: string;
  priority?: number;
  settings?: Record<string, string>;
  credentials?: Record<string, string>;
}
interface ProtoUpdate extends Omit<ProtoCreate, 'channel' | 'provider'> {
  id?: string;
  active?: boolean;
}

@AdminOnly()
@Controller()
export class ProviderController {
  constructor(private readonly providers: ProviderConfigService) {}

  @GrpcMethod(SERVICE, 'CreateProviderConfig')
  async create(@Payload() req: ProtoCreate) {
    const dto = validateInput(CreateProviderConfigDto, {
      ...req,
      channel: ChannelCodec.decode(req.channel),
      priority: req.priority ?? 0,
      settings: req.settings ?? {},
      credentials: req.credentials ?? {},
    });
    return toProtoProvider(await this.providers.create(dto));
  }

  @GrpcMethod(SERVICE, 'ListProviderConfigs')
  async list(@Payload() req: { tenantId?: string; channel?: string }) {
    const dto = validateInput(ListProviderConfigsDto, compact({ tenantId: req.tenantId, channel: ChannelCodec.decode(req.channel) }));
    return { providers: (await this.providers.list(dto)).map(toProtoProvider) };
  }

  @GrpcMethod(SERVICE, 'UpdateProviderConfig')
  async update(@Payload() req: ProtoUpdate) {
    const dto = validateInput(
      UpdateProviderConfigDto,
      compact({ ...req, settings: nonEmptyMap(req.settings), credentials: nonEmptyMap(req.credentials) }),
    );
    return toProtoProvider(await this.providers.update(dto));
  }

  @GrpcMethod(SERVICE, 'DeleteProviderConfig')
  async remove(@Payload() req: { tenantId?: string; id?: string }) {
    await this.providers.remove(validateInput(ProviderConfigRefDto, req));
    return {};
  }
}
