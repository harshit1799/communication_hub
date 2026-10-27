/**
 * Retry policy of a notification's job: the limits of the provider that will
 * deliver it (the first one after From selection), else the platform
 * defaults (QUEUE_ATTEMPTS, QUEUE_BACKOFF_MS). Computed when the job is
 * queued: on send, on manual retry and when the sweeper re-enqueues.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel } from '../../constant/index.js';
import { Notification } from '../../models/index.js';
import { selectFrom } from '../provider/from-addresses.js';
import { ProviderResolver } from '../provider/provider.resolver.js';

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

type PolicyInput = Pick<Notification, 'tenantId' | 'channel' | 'fromAddress'>;

@Injectable()
export class RetryPolicyService {
  private readonly defaults: RetryPolicy;

  constructor(
    private readonly providers: ProviderResolver,
    config: ConfigService,
  ) {
    const { queue } = config.getOrThrow<AppConfig>('app');
    this.defaults = { attempts: queue.attempts, backoffMs: queue.backoffMs };
  }

  /** Policy for one notification; never throws (falls back to the defaults). */
  async forNotification(n: PolicyInput): Promise<RetryPolicy> {
    // In-app retries are inbox writes, not provider calls.
    if (n.channel === NotificationChannel.InApp) return this.defaults;
    try {
      const handles = await this.providers.resolve(n.tenantId, n.channel);
      const selection = selectFrom(n.channel, handles, n.fromAddress, '');
      const limits = (selection.ok ? selection.handles[0] : handles[0])?.spec.limits ?? {};
      return { attempts: limits.maxAttempts ?? this.defaults.attempts, backoffMs: limits.backoffMs ?? this.defaults.backoffMs };
    } catch {
      return this.defaults;
    }
  }

  /** Policies for many notifications, one lookup per tenant / channel / From. */
  async forMany<T extends PolicyInput>(items: T[]): Promise<Map<T, RetryPolicy>> {
    const byKey = new Map<string, Promise<RetryPolicy>>();
    const result = new Map<T, RetryPolicy>();
    for (const n of items) {
      const key = `${n.tenantId}:${n.channel}:${n.fromAddress ?? ''}`;
      if (!byKey.has(key)) byKey.set(key, this.forNotification(n));
      result.set(n, await byKey.get(key)!);
    }
    return result;
  }
}
