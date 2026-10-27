/**
 * A tenant's management of its own providers. Validates settings and
 * credentials per provider kind before storing (credentials encrypted by
 * the entity transformer) and drops the send-path cache on every change,
 * so the next message uses the new configuration.
 */

import { Injectable } from '@nestjs/common';
import { CreateProviderDto, UpdateProviderDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { ProviderConfig } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { NotificationChannel } from '../../constant/index.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { addressesOf, validateFromAddresses } from './from-addresses.js';
import { validateProviderConfig } from './provider.factory.js';
import { ProviderResolver } from './provider.resolver.js';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class ProviderConfigService {
  constructor(
    private readonly configs: ProviderConfigRepository,
    private readonly resolver: ProviderResolver,
  ) {}

  async create(tenantId: string, dto: CreateProviderDto): Promise<ProviderConfig> {
    this.assertValid([
      ...validateProviderConfig(dto.channel, dto.provider, dto.settings, dto.credentials),
      ...validateFromAddresses(dto.channel, dto.fromAddresses),
    ]);
    try {
      const saved = await this.configs.create({
        tenantId,
        channel: dto.channel,
        provider: dto.provider as ProviderConfig['provider'],
        name: dto.name,
        priority: dto.priority,
        isActive: true,
        settings: dto.settings,
        fromAddresses: dto.fromAddresses,
        credentials: dto.credentials,
      });
      await this.resolver.invalidate(tenantId, saved.channel);
      return saved;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppException(ERROR.PROVIDER_NAME_TAKEN);
      throw err;
    }
  }

  list(tenantId: string, channel?: NotificationChannel): Promise<ProviderConfig[]> {
    return this.configs.list(tenantId, channel);
  }

  async get(tenantId: string, id: string): Promise<ProviderConfig> {
    const config = await this.configs.findForTenant(tenantId, id);
    if (!config) throw new AppException(ERROR.PROVIDER_CONFIG_NOT_FOUND);
    return config;
  }

  /** Settings are merged ("" removes a key); credentials, when given, replace. */
  async update(tenantId: string, dto: UpdateProviderDto): Promise<ProviderConfig> {
    const config = await this.get(tenantId, dto.id);
    const settings = { ...config.settings, ...dto.settings };
    for (const [key, value] of Object.entries(settings)) if (value === '') delete settings[key];
    const credentials = dto.credentials ?? config.credentials;
    const fromAddresses = { ...config.fromAddresses, ...dto.fromAddresses };
    for (const [name, address] of Object.entries(fromAddresses)) if (address === '') delete fromAddresses[name];
    this.assertValid([
      ...validateProviderConfig(config.channel, config.provider, settings, credentials),
      ...validateFromAddresses(config.channel, fromAddresses),
    ]);

    if (dto.name !== undefined) config.name = dto.name;
    if (dto.priority !== undefined) config.priority = dto.priority;
    if (dto.active !== undefined) config.isActive = dto.active;
    config.settings = settings;
    config.fromAddresses = fromAddresses;
    config.credentials = credentials;
    try {
      const saved = await this.configs.save(config);
      await this.resolver.invalidate(tenantId, saved.channel);
      return saved;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppException(ERROR.PROVIDER_NAME_TAKEN);
      throw err;
    }
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const config = await this.get(tenantId, id);
    await this.configs.deleteWhere({ id: config.id });
    await this.resolver.invalidate(tenantId, config.channel);
  }

  /**
   * Every From the tenant can send with, in failover order: name (or the
   * provider default), address and the provider that sends it.
   */
  async fromAddresses(tenantId: string, channel?: NotificationChannel) {
    const configs = (await this.configs.list(tenantId, channel)).filter(
      (c) => c.channel === NotificationChannel.Email || c.channel === NotificationChannel.Sms,
    );
    return configs.flatMap((c) =>
      addressesOf(c).map((a) => ({ ...a, channel: c.channel, providerId: c.id, providerName: c.name, provider: c.provider, active: c.isActive })),
    );
  }

  private assertValid(errors: string[]) {
    if (errors.length > 0) throw new AppException(ERROR.PROVIDER_CONFIG_INVALID, { errors }, { reason: errors[0] });
  }
}
