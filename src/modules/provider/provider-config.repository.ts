/**
 * Data access for the `provider_configs` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel, ProviderChannel } from '../../constant/index.js';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { ProviderConfig } from '../../models/index.js';
import type { ProviderSpec } from './provider.types.js';

@Injectable()
export class ProviderConfigRepository extends BaseRepository<ProviderConfig> {
  constructor(@InjectRepository(ProviderConfig) repository: Repository<ProviderConfig>) {
    super(repository);
  }

  /** A config of this tenant, or null. */
  findForTenant(tenantId: string, id: string): Promise<ProviderConfig | null> {
    return this.findOne({ tenantId, id });
  }

  /** The tenant's configs (optionally one channel), in failover order. */
  list(tenantId: string, channel?: NotificationChannel): Promise<ProviderConfig[]> {
    return this.findMany(channel ? { tenantId, channel } : { tenantId }, { order: { channel: 'ASC', priority: 'ASC', name: 'ASC' } });
  }

  /**
   * Active configs for the send path, in failover order. Raw select, so the
   * credentials stay ciphertext (they are cached in Redis as such).
   */
  async activeSpecs(tenantId: string, channel: ProviderChannel): Promise<ProviderSpec[]> {
    const rows = await this.queryBuilder('p')
      .select(['p.id', 'p.channel', 'p.provider', 'p.name', 'p.priority', 'p.settings', 'p.fromAddresses', 'p.credentials', 'p.updatedAt'])
      .where('p.tenant_id = :tenantId AND p.channel = :channel AND p.is_active', { tenantId, channel })
      .orderBy('p.priority', 'ASC')
      .addOrderBy('p.name', 'ASC')
      .getRawMany<{
        p_id: string;
        p_channel: ProviderChannel;
        p_provider: ProviderSpec['provider'];
        p_name: string;
        p_priority: number;
        p_settings: Record<string, string>;
        p_from_addresses: Record<string, string>;
        p_credentials: string;
        p_updated_at: Date;
      }>();
    return rows.map((r) => ({
      id: r.p_id,
      channel: r.p_channel,
      provider: r.p_provider,
      name: r.p_name,
      priority: r.p_priority,
      settings: r.p_settings,
      fromAddresses: r.p_from_addresses ?? {},
      credentials: r.p_credentials,
      version: new Date(r.p_updated_at).toISOString(),
    }));
  }
}
