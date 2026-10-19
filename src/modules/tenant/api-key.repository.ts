/**
 * Data access for the `api_keys` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ApiKey } from '../../models/index.js';

/** Thin wrapper around the TypeORM repository. */
@Injectable()
export class ApiKeyRepository {
  constructor(@InjectRepository(ApiKey) private readonly keys: Repository<ApiKey>) {}

  /** Stores a new key (hash and prefix only). */
  create(input: {
    tenantId: string;
    name: string;
    prefix: string;
    keyHash: string;
    expiresAt?: Date | null;
  }): Promise<ApiKey> {
    return this.keys.save(this.keys.create({ ...input, expiresAt: input.expiresAt ?? null }));
  }

  /** Key with its tenant, for authentication. */
  findByHashWithTenant(keyHash: string): Promise<ApiKey | null> {
    return this.keys.findOne({ where: { keyHash }, relations: { tenant: true } });
  }

  /** All keys of a tenant, newest first. */
  findByTenant(tenantId: string): Promise<ApiKey[]> {
    return this.keys.find({ where: { tenantId }, order: { createdAt: 'DESC' } });
  }

  /** A key of this tenant, or null (other tenants' keys are invisible). */
  findOne(tenantId: string, id: string): Promise<ApiKey | null> {
    return this.keys.findOneBy({ tenantId, id });
  }

  /** Hashes of the tenant's live keys (to invalidate their cache entries). */
  async activeHashes(tenantId: string): Promise<string[]> {
    const rows = await this.keys.find({
      select: { keyHash: true },
      where: { tenantId, revokedAt: IsNull() },
    });
    return rows.map((r) => r.keyHash);
  }

  /** Sets revoked_at to now. */
  async revoke(id: string): Promise<void> {
    await this.keys.update({ id }, { revokedAt: new Date() });
  }

  /** Records that the key was just used. */
  async touch(id: string): Promise<void> {
    await this.keys.update({ id }, { lastUsedAt: new Date() });
  }
}
