/**
 * Data access for `sender_identities` and `sender_rules`.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel } from '../../constant/index.js';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { SenderIdentity, SenderRule } from '../../models/index.js';

/** A tenant's sender configuration for one channel, as cached for the send path. */
export interface SenderSnapshot {
  senders: Pick<SenderIdentity, 'id' | 'value' | 'providerConfigId' | 'isDefault' | 'isActive'>[];
  rules: Pick<SenderRule, 'id' | 'templateId' | 'matchType' | 'matchValue' | 'senderId' | 'priority'>[];
}

@Injectable()
export class SenderRepository extends BaseRepository<SenderIdentity> {
  constructor(
    @InjectRepository(SenderIdentity) repository: Repository<SenderIdentity>,
    @InjectRepository(SenderRule) private readonly rules: Repository<SenderRule>,
  ) {
    super(repository);
  }

  findForTenant(tenantId: string, id: string): Promise<SenderIdentity | null> {
    return this.findOne({ tenantId, id });
  }

  list(tenantId: string, channel?: NotificationChannel): Promise<SenderIdentity[]> {
    return this.findMany(channel ? { tenantId, channel } : { tenantId }, { order: { channel: 'ASC', createdAt: 'ASC' } });
  }

  /**
   * Saves a sender; when it is the default, the previous default of the
   * channel is unset in the same transaction (one default per channel).
   */
  saveSender(sender: SenderIdentity): Promise<SenderIdentity> {
    return this.transaction(async (m) => {
      const repo = m.getRepository(SenderIdentity);
      if (sender.isDefault) {
        const qb = repo
          .createQueryBuilder()
          .update()
          .set({ isDefault: false })
          .where('tenant_id = :tenantId AND channel = :channel AND is_default', { tenantId: sender.tenantId, channel: sender.channel });
        if (sender.id) qb.andWhere('id <> :id', { id: sender.id });
        await qb.execute();
      }
      return repo.save(sender);
    });
  }

  newSender(data: Partial<SenderIdentity>): SenderIdentity {
    return this.repository.create(data);
  }

  // ---------- Rules ----------

  createRule(data: Partial<SenderRule>): Promise<SenderRule> {
    return this.rules.save(this.rules.create(data));
  }

  listRules(tenantId: string, channel?: NotificationChannel): Promise<SenderRule[]> {
    return this.rules.find({
      where: channel ? { tenantId, channel } : { tenantId },
      order: { channel: 'ASC', priority: 'ASC', createdAt: 'ASC' },
    });
  }

  findRule(tenantId: string, id: string): Promise<SenderRule | null> {
    return this.rules.findOneBy({ tenantId, id });
  }

  async deleteRule(id: string): Promise<void> {
    await this.rules.delete({ id });
  }

  /** Everything the send path needs for one channel, in two indexed queries. */
  async snapshot(tenantId: string, channel: NotificationChannel): Promise<SenderSnapshot> {
    const [senders, rules] = await Promise.all([
      this.findMany({ tenantId, channel }, { select: { id: true, value: true, providerConfigId: true, isDefault: true, isActive: true } }),
      this.rules.find({
        where: { tenantId, channel },
        select: { id: true, templateId: true, matchType: true, matchValue: true, senderId: true, priority: true },
        order: { priority: 'ASC', createdAt: 'ASC' },
      }),
    ]);
    return { senders, rules };
  }
}
