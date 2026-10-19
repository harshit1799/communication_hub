/**
 * API key resolution: cache hit, database fallback when Redis is down,
 * and rejection of revoked/expired keys and inactive tenants.
 */

import { ConfigService } from '@nestjs/config';
import { AppException } from '../../exceptions/index.js';
import { ApiKey } from '../../models/index.js';
import { sha256 } from '../../utils/appUtils.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyService } from './api-key.service.js';

/** Raw key used in every test; only its hash reaches the repository. */
const KEY = 'chk_test';
/** An active tenant returned with the key. */
const tenant = { id: 't-1', name: 'Acme', slug: 'acme', isActive: true, settings: {} };

/** ApiKeyService with a fake repository (returning `row`) and fake Redis. */
function setup(row: Partial<ApiKey> | null) {
  const repo = {
    findByHashWithTenant: vi.fn().mockResolvedValue(
      row && { id: 'k-1', tenantId: 't-1', revokedAt: null, expiresAt: null, tenant, ...row },
    ),
    touch: vi.fn().mockResolvedValue(undefined),
  };
  const redis = {
    getJson: vi.fn().mockResolvedValue(null),
    setJson: vi.fn().mockResolvedValue(undefined),
  };
  const config = { getOrThrow: () => ({ auth: { apiKeyCacheTtlSeconds: 60 } }) } as unknown as ConfigService;
  const service = new ApiKeyService(
    repo as unknown as ApiKeyRepository,
    redis as unknown as RedisService,
    config,
  );
  return { service, repo, redis };
}

describe('ApiKeyService.resolve', () => {
  it('loads from the database and caches the result', async () => {
    const t = setup({});
    await expect(t.service.resolve(KEY)).resolves.toMatchObject({ tenantId: 't-1', slug: 'acme' });
    expect(t.repo.findByHashWithTenant).toHaveBeenCalledWith(sha256(KEY));
    expect(t.redis.setJson).toHaveBeenCalled();
  });

  it('serves from cache without touching the database', async () => {
    const t = setup({});
    t.redis.getJson.mockResolvedValue({ tenantId: 't-1', apiKeyId: 'k-1', expiresAt: null });
    await t.service.resolve(KEY);
    expect(t.repo.findByHashWithTenant).not.toHaveBeenCalled();
  });

  it('falls back to the database when Redis is down', async () => {
    const t = setup({});
    t.redis.getJson.mockRejectedValue(new Error('ECONNREFUSED'));
    t.redis.setJson.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(t.service.resolve(KEY)).resolves.toMatchObject({ tenantId: 't-1' });
  });

  it.each([
    ['unknown', null],
    ['revoked', { revokedAt: new Date() }],
    ['inactive tenant', { tenant: { ...tenant, isActive: false } }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('rejects %s keys', async (_name, row) => {
    const t = setup(row as Partial<ApiKey> | null);
    await expect(t.service.resolve(KEY)).rejects.toBeInstanceOf(AppException);
  });
});
