/**
 * Issues, resolves and revokes tenant API keys.
 *
 * Resolution is on the hot path of every request, so the result is cached
 * in Redis for API_KEY_CACHE_TTL_SECONDS. Revoking a key or changing the
 * tenant invalidates the cache immediately. If Redis is down we fall back
 * to Postgres rather than rejecting traffic.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { REDIS_KEY } from '../../constant/index.js';
import { TenantContext } from '../../decorator/tenant.decorator.js';
import { AppException } from '../../exceptions/index.js';
import { ApiKey } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { apiKeyPrefix, errorMessage, generateApiKey, sha256 } from '../../utils/appUtils.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { ApiKeyRepository } from './api-key.repository.js';

/** What is cached per key hash: the tenant plus the key's expiry. */
interface CachedKey extends TenantContext {
  expiresAt: string | null;
}

/** Used by AuthGuard on every tenant request and by TenantService. */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly cacheTtl: number;

  constructor(
    private readonly apiKeys: ApiKeyRepository,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.cacheTtl = config.getOrThrow<AppConfig>('app').auth.apiKeyCacheTtlSeconds;
  }

  /** Creates a key and returns the raw value (shown to the caller once). */
  async issue(
    tenantId: string,
    name: string,
    expiresAt?: Date,
    // Use a known value (bootstrap) instead of generating one.
    rawKey = generateApiKey(),
  ): Promise<{ apiKey: ApiKey; key: string }> {
    const apiKey = await this.apiKeys.createKey({
      tenantId,
      name,
      prefix: apiKeyPrefix(rawKey),
      keyHash: sha256(rawKey),
      expiresAt,
    });
    return { apiKey, key: rawKey };
  }

  /** Validates a raw key and returns its tenant. Throws 401/403 otherwise. */
  async resolve(rawKey: string): Promise<TenantContext> {
    const hash = sha256(rawKey);
    const cached = await this.readCache(hash);
    const entry = cached ?? (await this.loadFromDb(hash));

    if (entry.expiresAt && new Date(entry.expiresAt) <= new Date()) {
      throw new AppException(ERROR.API_KEY_INVALID);
    }
    const { expiresAt: _expiresAt, ...tenant } = entry;
    return tenant;
  }

  /** Revokes the key and drops it from the cache. */
  async revoke(apiKey: ApiKey): Promise<void> {
    await this.apiKeys.revoke(apiKey.id);
    await this.invalidate([apiKey.keyHash]);
  }

  /** Drops cached entries so changes (revocation, tenant updates) apply now. */
  async invalidateTenant(tenantId: string): Promise<void> {
    await this.invalidate(await this.apiKeys.activeHashes(tenantId));
  }

  /**
   * Loads and validates the key from Postgres, then caches it and
   * updates last_used_at in the background.
   */
  private async loadFromDb(hash: string): Promise<CachedKey> {
    const apiKey = await this.apiKeys.findByHashWithTenant(hash);
    if (!apiKey?.tenant || apiKey.revokedAt) {
      throw new AppException(ERROR.API_KEY_INVALID);
    }
    if (!apiKey.tenant.isActive) throw new AppException(ERROR.TENANT_INACTIVE);

    const entry: CachedKey = {
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey.id,
      name: apiKey.tenant.name,
      slug: apiKey.tenant.slug,
      settings: apiKey.tenant.settings,
      expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    };
    // Best effort; neither failure should fail the request.
    void this.redis
      .setJson(REDIS_KEY.apiKey(hash), entry, this.cacheTtl)
      .catch((err) => this.logger.warn(`API key cache write failed: ${errorMessage(err)}`));
    // Updated at most once per cache TTL per key, not on every request.
    void this.apiKeys
      .touch(apiKey.id)
      .catch((err) => this.logger.warn(`last_used_at update failed: ${errorMessage(err)}`));
    return entry;
  }

  /** Cached entry, or null on a miss or when Redis is unavailable. */
  private async readCache(hash: string): Promise<CachedKey | null> {
    try {
      return await this.redis.getJson<CachedKey>(REDIS_KEY.apiKey(hash));
    } catch (err) {
      this.logger.warn(`API key cache unavailable, using database: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Deletes cache entries; logs instead of failing if Redis is down. */
  private async invalidate(hashes: string[]): Promise<void> {
    try {
      await this.redis.del(...hashes.map((h) => REDIS_KEY.apiKey(h)));
    } catch (err) {
      // Entries still expire on their own after the cache TTL.
      this.logger.error(`API key cache invalidation failed: ${errorMessage(err)}`);
    }
  }
}
