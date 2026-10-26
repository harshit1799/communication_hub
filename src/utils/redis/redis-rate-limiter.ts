/**
 * Fixed-window counter in Redis, shared by every API replica. The first hit
 * creates the counter with the window TTL. If Redis is unavailable the
 * limiter fails open: a cache outage must not take the whole API down.
 */

import { Injectable, Logger } from '@nestjs/common';
import { REDIS_KEY } from '../../constant/index.js';
import { RedisService } from './redis.service.js';

// INCR + set expiry on first hit, atomically. Returns [hits, ttlMs].
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

@Injectable()
export class RedisRateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  /** Counts one hit for `key` in a window of `windowMs`. */
  async hit(key: string, windowMs: number): Promise<{ hits: number; retryAfterSeconds: number }> {
    try {
      const [hits, pttl] = (await this.redis.client.eval(
        INCREMENT_SCRIPT,
        1,
        this.redis.key(REDIS_KEY.throttle(key)),
        windowMs,
      )) as [number, number];
      return { hits, retryAfterSeconds: Math.max(Math.ceil(pttl / 1000), 0) };
    } catch (err) {
      this.logger.warn(`Rate limiter unavailable, allowing request: ${String(err)}`);
      return { hits: 0, retryAfterSeconds: 0 };
    }
  }
}
