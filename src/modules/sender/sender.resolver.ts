/**
 * Picks the sender for a notification at send time:
 *
 *   1. the sender the client asked for (sender_id), which must still be active
 *   2. the first matching rule: rules for this template, then general rules,
 *      each by ascending priority; rules pointing at inactive senders skip
 *   3. the tenant's default sender for the channel
 *   4. none: the provider's own default applies (MAIL_FROM for the platform
 *      email provider, a Twilio messaging service, ...)
 *
 * Reads the tenant's sender snapshot from Redis (SENDER_CACHE_TTL_SECONDS),
 * falling back to Postgres. SenderService deletes it on every change.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, REDIS_KEY, SENDER_CHANNELS, SenderRuleMatch } from '../../constant/index.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { SenderRepository, SenderSnapshot } from './sender.repository.js';

/** The chosen sender. */
export interface ResolvedSender {
  senderId: string;
  value: string;
  // Provider config to try first (sender pinned to one account).
  providerConfigId: string | null;
  // How it was chosen, for logs and debugging.
  source: 'request' | 'rule' | 'default';
}

export interface SenderQuery {
  tenantId: string;
  channel: NotificationChannel;
  senderId?: string | null;
  templateId?: string | null;
  recipient?: string | null;
}

type Rule = SenderSnapshot['rules'][number];

/** Whether a rule matches the recipient. */
export function ruleMatches(rule: Pick<Rule, 'matchType' | 'matchValue'>, recipient: string | null | undefined): boolean {
  switch (rule.matchType) {
    case SenderRuleMatch.Any:
      return true;
    case SenderRuleMatch.RecipientPrefix:
      return !!recipient && !!rule.matchValue && recipient.startsWith(rule.matchValue);
    case SenderRuleMatch.RecipientDomain: {
      const domain = recipient?.split('@')[1]?.toLowerCase();
      return !!domain && domain === rule.matchValue?.toLowerCase();
    }
    default:
      return false;
  }
}

/** Pure selection over a snapshot (unit-tested without Redis/Postgres). */
export function selectSender(snapshot: SenderSnapshot, query: Omit<SenderQuery, 'tenantId' | 'channel'>): ResolvedSender | null {
  const active = new Map(snapshot.senders.filter((s) => s.isActive).map((s) => [s.id, s]));
  const pick = (id: string, source: ResolvedSender['source']): ResolvedSender | null => {
    const s = active.get(id);
    return s ? { senderId: s.id, value: s.value, providerConfigId: s.providerConfigId, source } : null;
  };

  if (query.senderId) {
    const requested = pick(query.senderId, 'request');
    // An explicit choice is never silently replaced by another sender.
    if (!requested) throw new PermanentDeliveryError(`Sender ${query.senderId} is no longer active`, 'sender');
    return requested;
  }

  const ordered = [
    ...snapshot.rules.filter((r) => query.templateId && r.templateId === query.templateId),
    ...snapshot.rules.filter((r) => !r.templateId),
  ];
  for (const rule of ordered) {
    if (!ruleMatches(rule, query.recipient)) continue;
    const chosen = pick(rule.senderId, 'rule');
    if (chosen) return chosen;
  }

  const fallback = snapshot.senders.find((s) => s.isDefault && s.isActive);
  return fallback ? pick(fallback.id, 'default') : null;
}

@Injectable()
export class SenderResolver {
  private readonly ttl: number;

  constructor(
    private readonly senders: SenderRepository,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = config.getOrThrow<AppConfig>('app').cache.senderTtlSeconds;
  }

  /** The sender to use, or null (push, or nothing configured). */
  async resolve(query: SenderQuery): Promise<ResolvedSender | null> {
    if (!SENDER_CHANNELS.includes(query.channel)) return null;
    return selectSender(await this.snapshot(query.tenantId, query.channel), query);
  }

  /** Whether the sender exists and is active for this tenant and channel (accept-time check). */
  async isUsable(tenantId: string, channel: NotificationChannel, senderId: string): Promise<boolean> {
    if (!SENDER_CHANNELS.includes(channel)) return false;
    return (await this.snapshot(tenantId, channel)).senders.some((s) => s.id === senderId && s.isActive);
  }

  invalidate(tenantId: string, channel: NotificationChannel): Promise<void> {
    return this.redis.invalidate(REDIS_KEY.senders(tenantId, channel));
  }

  private snapshot(tenantId: string, channel: NotificationChannel): Promise<SenderSnapshot> {
    return this.redis.cached(REDIS_KEY.senders(tenantId, channel), this.ttl, () => this.senders.snapshot(tenantId, channel));
  }
}
