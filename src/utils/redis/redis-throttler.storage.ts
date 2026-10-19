/**
 * Redis-backed storage for @nestjs/throttler, so rate limits are shared by
 * every API replica (the default in-memory storage is per process).
 *
 * Fixed window: the first hit creates the counter with the window TTL.
 * If Redis is unavailable the limiter fails open: a cache outage must not
 * take the whole API down.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { REDIS_KEY } from '../../constant/index.js';
import { RedisService } from './redis.service.js';

// INCR + set expiry on first hit, atomically. Returns [hits, ttlMs].
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

/** Plugged into ThrottlerModule in AppModule. */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Counts one hit. `ttl` is the window in ms; returns seconds as the
   * throttler expects.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ) {
    try {
      const [hits, pttl] = (await this.redis.client.eval(
        INCREMENT_SCRIPT,
        1,
        // `key` already includes the throttler name (TenantThrottlerGuard).
        this.redis.key(REDIS_KEY.throttle(key)),
        ttl,
      )) as [number, number];
      const timeToExpire = Math.max(Math.ceil(pttl / 1000), 0);
      const isBlocked = hits > limit;
      return {
        totalHits: hits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (err) {
      this.logger.warn(`Rate limiter unavailable, allowing request: ${String(err)}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
