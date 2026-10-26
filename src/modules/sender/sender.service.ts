/**
 * Management of a tenant's sender identities and sender rules. Every change
 * drops the channel's cached snapshot, so it applies to the next send.
 */

import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '../../constant/index.js';
import { CreateSenderDto, CreateSenderRuleDto, UpdateSenderDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { SenderIdentity, SenderRule } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { ProviderConfigRepository } from '../provider/provider-config.repository.js';
import { TemplateRepository } from '../template/template.repository.js';
import { SenderRepository } from './sender.repository.js';
import { SenderResolver } from './sender.resolver.js';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class SenderService {
  constructor(
    private readonly senders: SenderRepository,
    private readonly resolver: SenderResolver,
    private readonly providers: ProviderConfigRepository,
    private readonly templates: TemplateRepository,
  ) {}

  async create(tenantId: string, dto: CreateSenderDto): Promise<SenderIdentity> {
    if (dto.providerConfigId) await this.assertProvider(tenantId, dto.channel, dto.providerConfigId);
    const sender = this.senders.newSender({
      tenantId,
      channel: dto.channel,
      value: dto.value.trim(),
      label: dto.label ?? null,
      providerConfigId: dto.providerConfigId ?? null,
      isDefault: dto.isDefault,
      isActive: true,
    });
    return this.persist(sender);
  }

  list(tenantId: string, channel?: NotificationChannel): Promise<SenderIdentity[]> {
    return this.senders.list(tenantId, channel);
  }

  async update(tenantId: string, dto: UpdateSenderDto): Promise<SenderIdentity> {
    const sender = await this.get(tenantId, dto.id);
    if (dto.label !== undefined) sender.label = dto.label || null;
    if (dto.isDefault !== undefined) sender.isDefault = dto.isDefault;
    if (dto.active !== undefined) sender.isActive = dto.active;
    if (dto.providerConfigId !== undefined) {
      if (dto.providerConfigId) await this.assertProvider(tenantId, sender.channel, dto.providerConfigId);
      sender.providerConfigId = dto.providerConfigId || null;
    }
    // An inactive sender can't stay the channel default.
    if (!sender.isActive) sender.isDefault = false;
    return this.persist(sender);
  }

  /** Deletes the sender (its rules cascade; notifications keep their history). */
  async remove(tenantId: string, id: string): Promise<void> {
    const sender = await this.get(tenantId, id);
    await this.senders.deleteWhere({ id: sender.id });
    await this.resolver.invalidate(tenantId, sender.channel);
  }

  // ---------- Rules ----------

  async createRule(tenantId: string, dto: CreateSenderRuleDto): Promise<SenderRule> {
    const sender = await this.get(tenantId, dto.senderId);
    if (sender.channel !== dto.channel) {
      throw new AppException(ERROR.VALIDATION_ERROR, { errors: ['sender_id belongs to another channel'] }, { detail: 'sender_id belongs to another channel' });
    }
    if (dto.templateId) {
      const template = await this.templates.findForTenant(tenantId, dto.templateId);
      if (!template || template.channel !== dto.channel) {
        throw new AppException(ERROR.TEMPLATE_NOT_FOUND, { channel: dto.channel }, { template: dto.templateId });
      }
    }
    const rule = await this.senders.createRule({
      tenantId,
      channel: dto.channel,
      templateId: dto.templateId ?? null,
      matchType: dto.match,
      matchValue: dto.matchValue?.trim() || null,
      senderId: dto.senderId,
      priority: dto.priority,
    });
    await this.resolver.invalidate(tenantId, dto.channel);
    return rule;
  }

  listRules(tenantId: string, channel?: NotificationChannel): Promise<SenderRule[]> {
    return this.senders.listRules(tenantId, channel);
  }

  async removeRule(tenantId: string, id: string): Promise<void> {
    const rule = await this.senders.findRule(tenantId, id);
    if (!rule) throw new AppException(ERROR.SENDER_RULE_NOT_FOUND);
    await this.senders.deleteRule(rule.id);
    await this.resolver.invalidate(tenantId, rule.channel);
  }

  // ---------- Helpers ----------

  private async get(tenantId: string, id: string): Promise<SenderIdentity> {
    const sender = await this.senders.findForTenant(tenantId, id);
    if (!sender) throw new AppException(ERROR.SENDER_NOT_FOUND);
    return sender;
  }

  private async persist(sender: SenderIdentity): Promise<SenderIdentity> {
    try {
      const saved = await this.senders.saveSender(sender);
      await this.resolver.invalidate(sender.tenantId, sender.channel);
      return saved;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppException(ERROR.SENDER_VALUE_TAKEN);
      throw err;
    }
  }

  /** A pinned provider must be this tenant's and deliver on the same channel. */
  private async assertProvider(tenantId: string, channel: NotificationChannel, id: string) {
    const config = await this.providers.findForTenant(tenantId, id);
    if (!config || config.channel !== channel) throw new AppException(ERROR.PROVIDER_CONFIG_NOT_FOUND);
  }
}
