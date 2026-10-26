/**
 * Admin management of tenants' provider configs. Validates settings and
 * credentials per provider kind before storing (credentials encrypted by
 * the entity transformer) and drops the send-path cache on every change.
 */

import { Injectable } from '@nestjs/common';
import { REDIS_KEY } from '../../constant/index.js';
import { CreateProviderConfigDto, ListProviderConfigsDto, ProviderConfigRefDto, UpdateProviderConfigDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { ProviderConfig } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { validateProviderConfig } from './provider.factory.js';
import { ProviderResolver } from './provider.resolver.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

@Injectable()
export class ProviderConfigService {
  constructor(
    private readonly configs: ProviderConfigRepository,
    private readonly resolver: ProviderResolver,
    private readonly redis: RedisService,
  ) {}

  async create(dto: CreateProviderConfigDto): Promise<ProviderConfig> {
    this.assertValid(validateProviderConfig(dto.channel, dto.provider, dto.settings, dto.credentials));
    try {
      const saved = await this.configs.create({
        tenantId: dto.tenantId,
        channel: dto.channel,
        provider: dto.provider as ProviderConfig['provider'],
        name: dto.name,
        priority: dto.priority,
        isActive: true,
        settings: dto.settings,
        credentials: dto.credentials,
      });
      await this.invalidate(saved);
      return saved;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION) throw new AppException(ERROR.PROVIDER_NAME_TAKEN);
      if (code === FOREIGN_KEY_VIOLATION) throw new AppException(ERROR.TENANT_NOT_FOUND);
      throw err;
    }
  }

  list(dto: ListProviderConfigsDto): Promise<ProviderConfig[]> {
    return this.configs.list(dto.tenantId, dto.channel);
  }

  /** Settings are merged ("" removes a key); credentials, when given, replace. */
  async update(dto: UpdateProviderConfigDto): Promise<ProviderConfig> {
    const config = await this.get(dto);
    const settings = { ...config.settings, ...dto.settings };
    for (const [key, value] of Object.entries(settings)) if (value === '') delete settings[key];
    const credentials = dto.credentials ?? config.credentials;
    this.assertValid(validateProviderConfig(config.channel, config.provider, settings, credentials));

    if (dto.name !== undefined) config.name = dto.name;
    if (dto.priority !== undefined) config.priority = dto.priority;
    if (dto.active !== undefined) config.isActive = dto.active;
    config.settings = settings;
    config.credentials = credentials;
    try {
      const saved = await this.configs.save(config);
      await this.invalidate(saved);
      return saved;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppException(ERROR.PROVIDER_NAME_TAKEN);
      throw err;
    }
  }

  /** Deletes the config; senders pinned to it fall back to priority order. */
  async remove(dto: ProviderConfigRefDto): Promise<void> {
    const config = await this.get(dto);
    await this.configs.deleteWhere({ id: config.id });
    await this.invalidate(config);
  }

  private async get(ref: { tenantId: string; id: string }): Promise<ProviderConfig> {
    const config = await this.configs.findForTenant(ref.tenantId, ref.id);
    if (!config) throw new AppException(ERROR.PROVIDER_CONFIG_NOT_FOUND);
    return config;
  }

  private assertValid(errors: string[]) {
    if (errors.length > 0) throw new AppException(ERROR.PROVIDER_CONFIG_INVALID, { errors }, { reason: errors[0] });
  }

  /** Provider list and sender snapshot (senders may be pinned to this config). */
  private async invalidate(config: ProviderConfig): Promise<void> {
    await Promise.all([
      this.resolver.invalidate(config.tenantId, config.channel),
      this.redis.invalidate(REDIS_KEY.senders(config.tenantId, config.channel)),
    ]);
  }
}
