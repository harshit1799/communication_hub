/**
 * Send-path provider selection. For a tenant and channel it returns the
 * providers to try, in order:
 *
 *   Redis "providers:<tenant>:<channel>"  (TTL PROVIDER_CACHE_TTL_SECONDS)
 *     miss / Redis down -> Postgres (active configs by priority)
 *   none configured -> the platform default from the environment
 *
 * A sender pinned to one provider config moves that config to the front.
 * Admin changes delete the cache key, so they apply to the next message.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, ProviderChannel, providerChannelOf, REDIS_KEY } from '../../constant/index.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { platformProviders, PlatformProvider } from './platform-providers.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { ProviderRegistry } from './provider.registry.js';
import type { ProviderHandle, ProviderSpec } from './provider.types.js';

@Injectable()
export class ProviderResolver {
  private readonly ttl: number;
  private readonly platform: Record<ProviderChannel, PlatformProvider>;

  constructor(
    private readonly configs: ProviderConfigRepository,
    private readonly registry: ProviderRegistry,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.ttl = app.cache.providerTtlSeconds;
    this.platform = platformProviders(app);
  }

  /**
   * Providers for this tenant and channel in failover order (never empty).
   * `preferredConfigId` (a sender's pinned provider) goes first if active.
   */
  async resolve(tenantId: string, notificationChannel: NotificationChannel, preferredConfigId?: string | null): Promise<ProviderHandle[]> {
    // In-app signals devices through the push providers.
    const channel = providerChannelOf(notificationChannel);
    const specs = await this.redis.cached(REDIS_KEY.providers(tenantId, channel), this.ttl, () =>
      this.configs.activeSpecs(tenantId, channel),
    );
    if (specs.length === 0) {
      const { spec, credentials } = this.platform[channel];
      return [{ spec, client: () => this.registry.get(spec, credentials) }];
    }
    const ordered = preferredConfigId ? this.preferFirst(specs, preferredConfigId) : specs;
    return ordered.map((spec) => ({ spec, client: () => this.registry.get(spec) }));
  }

  /** The platform default's provider name for a channel (attempt records before resolution). */
  platformName(channel: NotificationChannel): string {
    return this.platform[providerChannelOf(channel)].spec.provider;
  }

  /** Drops the cached list after a change to this tenant's configs. */
  invalidate(tenantId: string, channel: NotificationChannel): Promise<void> {
    return this.redis.invalidate(REDIS_KEY.providers(tenantId, channel));
  }

  private preferFirst(specs: ProviderSpec[], id: string): ProviderSpec[] {
    const preferred = specs.find((s) => s.id === id);
    return preferred ? [preferred, ...specs.filter((s) => s !== preferred)] : specs;
  }
}
