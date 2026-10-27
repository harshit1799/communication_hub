/**
 * Enforces a provider's rate limit and concurrency cap (ProviderLimits)
 * across every worker, in Redis, with one atomic script per send:
 *
 *   concurrency   a sorted set of leases (member = lease id, score = expiry);
 *                 expired leases (crashed workers) are dropped on every check
 *   rate          a fixed-window counter (INCR + PEXPIRE on the first hit)
 *
 * acquire() returns a lease to release() after the provider call, or how long
 * to wait. Providers without limits (and the platform defaults) skip Redis.
 * If Redis is unavailable the throttle fails open: sending beats stalling.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { errorMessage } from '../../utils/appUtils.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import type { ProviderSpec } from './provider.types.js';

// A lease outlives the slowest provider call; a crashed worker's lease frees itself.
const LEASE_TTL_MS = 120_000;
// Concurrency full: no expiry is known for the running sends, so check again soon.
const CONCURRENCY_RETRY_MS = 250;

// KEYS: 1 = leases (zset), 2 = rate window counter
// ARGV: now, lease id, lease ttl, max concurrency (0 = none), rate max (0 = none), window ms
// Returns { 1, 0, 0 } acquired | { 0, 1, waitMs } concurrency full | { 0, 2, waitMs } rate exceeded
const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local maxc = tonumber(ARGV[4])
local rmax = tonumber(ARGV[5])
if maxc > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  if redis.call('ZCARD', KEYS[1]) >= maxc then return { 0, 1, ${CONCURRENCY_RETRY_MS} } end
end
if rmax > 0 then
  local hits = redis.call('INCR', KEYS[2])
  if hits == 1 then redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[6])) end
  if hits > rmax then return { 0, 2, math.max(redis.call('PTTL', KEYS[2]), 1) } end
end
if maxc > 0 then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
end
return { 1, 0, 0 }
`;

export type ThrottleResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: 'rate' | 'concurrency'; retryAfterMs: number };

const NO_LEASE = { ok: true as const, release: () => Promise.resolve() };

@Injectable()
export class ProviderThrottle {
  private readonly logger = new Logger(ProviderThrottle.name);

  constructor(private readonly redis: RedisService) {}

  async acquire(spec: Pick<ProviderSpec, 'id' | 'limits'>): Promise<ThrottleResult> {
    const { rateMax, rateDurationMs, maxConcurrency } = spec.limits ?? {};
    if (!maxConcurrency && !(rateMax && rateDurationMs)) return NO_LEASE;

    // {id} hash tag: both keys on one Redis Cluster slot (required by the script).
    const leases = this.redis.key(`throttle:{${spec.id}}:leases`);
    const window = this.redis.key(`throttle:{${spec.id}}:rate`);
    const leaseId = randomUUID();
    try {
      const [acquired, reason, waitMs] = (await this.redis.client.eval(
        ACQUIRE_SCRIPT,
        2,
        leases,
        window,
        Date.now(),
        leaseId,
        LEASE_TTL_MS,
        maxConcurrency ?? 0,
        rateMax && rateDurationMs ? rateMax : 0,
        rateDurationMs ?? 0,
      )) as [number, number, number];
      if (acquired !== 1) return { ok: false, reason: reason === 1 ? 'concurrency' : 'rate', retryAfterMs: waitMs };
      if (!maxConcurrency) return NO_LEASE;
      return {
        ok: true,
        release: async () => {
          await this.redis.client.zrem(leases, leaseId).catch((err: Error) => this.logger.debug(`Lease release failed: ${err.message}`));
        },
      };
    } catch (err) {
      this.logger.warn(`Provider throttle unavailable for ${spec.id}, sending anyway: ${errorMessage(err)}`);
      return NO_LEASE;
    }
  }
}
