/**
 * communication_hub.v1.SenderService (tenant API key).
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import { CreateSenderDto, CreateSenderRuleDto, ListSendersDto, SenderIdDto, UpdateSenderDto } from '../../dto/index.js';
import { ChannelCodec, compact, SenderMatchCodec, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { SenderIdentity, SenderRule } from '../../models/index.js';
import { SenderService } from './sender.service.js';

const SERVICE = 'SenderService';

const toProtoSender = (s: SenderIdentity) =>
  compact({
    id: s.id,
    channel: ChannelCodec.encode(s.channel),
    value: s.value,
    label: s.label,
    providerConfigId: s.providerConfigId,
    isDefault: s.isDefault,
    active: s.isActive,
    createdAt: Timestamp.encode(s.createdAt),
    updatedAt: Timestamp.encode(s.updatedAt),
  });

const toProtoRule = (r: SenderRule) =>
  compact({
    id: r.id,
    channel: ChannelCodec.encode(r.channel),
    templateId: r.templateId,
    match: SenderMatchCodec.encode(r.matchType),
    matchValue: r.matchValue,
    senderId: r.senderId,
    priority: r.priority,
    createdAt: Timestamp.encode(r.createdAt),
  });

@Controller()
export class SenderController {
  constructor(private readonly senders: SenderService) {}

  @GrpcMethod(SERVICE, 'CreateSender')
  async create(@Payload() req: { channel?: string; value?: string; label?: string; providerConfigId?: string; isDefault?: boolean }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(CreateSenderDto, compact({ ...req, channel: ChannelCodec.decode(req.channel), isDefault: req.isDefault ?? false }));
    return toProtoSender(await this.senders.create(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'ListSenders')
  async list(@Payload() req: { channel?: string }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(ListSendersDto, compact({ channel: ChannelCodec.decode(req.channel) }));
    return { senders: (await this.senders.list(tenant.tenantId, dto.channel)).map(toProtoSender) };
  }

  @GrpcMethod(SERVICE, 'UpdateSender')
  async update(@Payload() req: Record<string, unknown>, @CurrentTenant() tenant: TenantContext) {
    return toProtoSender(await this.senders.update(tenant.tenantId, validateInput(UpdateSenderDto, compact(req))));
  }

  @GrpcMethod(SERVICE, 'DeleteSender')
  async remove(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    await this.senders.remove(tenant.tenantId, validateInput(SenderIdDto, req).id);
    return {};
  }

  @GrpcMethod(SERVICE, 'CreateSenderRule')
  async createRule(
    @Payload() req: { channel?: string; templateId?: string; match?: string; matchValue?: string; senderId?: string; priority?: number },
    @CurrentTenant() tenant: TenantContext,
  ) {
    const dto = validateInput(
      CreateSenderRuleDto,
      compact({ ...req, channel: ChannelCodec.decode(req.channel), match: SenderMatchCodec.decode(req.match), priority: req.priority ?? 100 }),
    );
    return toProtoRule(await this.senders.createRule(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'ListSenderRules')
  async listRules(@Payload() req: { channel?: string }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(ListSendersDto, compact({ channel: ChannelCodec.decode(req.channel) }));
    return { rules: (await this.senders.listRules(tenant.tenantId, dto.channel)).map(toProtoRule) };
  }

  @GrpcMethod(SERVICE, 'DeleteSenderRule')
  async removeRule(@Payload() req: { id?: string }, @CurrentTenant() tenant: TenantContext) {
    await this.senders.removeRule(tenant.tenantId, validateInput(SenderIdDto, req).id);
    return {};
  }
}
