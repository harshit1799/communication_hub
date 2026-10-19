/**
 * Data access for the `api_keys` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { ApiKey } from '../../models/index.js';

/** API key queries on top of BaseRepository. */
@Injectable()
export class ApiKeyRepository extends BaseRepository<ApiKey> {
  constructor(@InjectRepository(ApiKey) repository: Repository<ApiKey>) {
    super(repository);
  }

  /** Stores a new key (hash and prefix only). */
  createKey(input: { tenantId: string; name: string; prefix: string; keyHash: string; expiresAt?: Date | null }): Promise<ApiKey> {
    return this.create({ ...input, expiresAt: input.expiresAt ?? null });
  }

  /** Key with its tenant, for authentication. */
  findByHashWithTenant(keyHash: string): Promise<ApiKey | null> {
    return this.findOne({ keyHash }, { relations: { tenant: true } });
  }

  /** All keys of a tenant, newest first. */
  findByTenant(tenantId: string): Promise<ApiKey[]> {
    return this.findMany({ tenantId }, { order: { createdAt: 'DESC' } });
  }

  /** A key of this tenant, or null (other tenants' keys are invisible). */
  findForTenant(tenantId: string, id: string): Promise<ApiKey | null> {
    return this.findOne({ tenantId, id });
  }

  /** Hashes of the tenant's live keys (to invalidate their cache entries). */
  activeHashes(tenantId: string): Promise<string[]> {
    return this.pluck('keyHash', { tenantId, revokedAt: IsNull() });
  }

  /** Sets revoked_at to now. */
  async revoke(id: string): Promise<void> {
    await this.updateById(id, { revokedAt: new Date() });
  }

  /** Records that the key was just used. */
  async touch(id: string): Promise<void> {
    await this.updateById(id, { lastUsedAt: new Date() });
  }
}
