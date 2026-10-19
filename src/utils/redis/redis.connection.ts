/**
 * Builds ioredis connections from config, for both standalone Redis and
 * Redis Cluster (e.g. ElastiCache in cluster mode), with TLS when enabled.
 */

import { Cluster, Redis, RedisOptions } from 'ioredis';
import { RedisConfig } from '../../config/configuration.js';

/** A standalone or cluster ioredis client. */
export type RedisConnection = Redis | Cluster;

/** Options that differ between the cache client and BullMQ. */
export interface ConnectionOverrides {
  // BullMQ workers need `null` (block forever); the cache client fails fast.
  maxRetriesPerRequest: number | null;
  // Queue commands while reconnecting (BullMQ) vs. fail immediately (cache).
  enableOfflineQueue: boolean;
}

/**
 * Creates a standalone or cluster client from config, with TLS and a
 * capped reconnect backoff.
 */
export function createRedisConnection(
  config: RedisConfig,
  overrides: ConnectionOverrides,
): RedisConnection {
  const options: RedisOptions = {
    password: config.password,
    db: config.cluster ? undefined : config.db,
    tls: config.tls ? {} : undefined,
    // Back off up to 2s between reconnects instead of hammering Redis.
    retryStrategy: (times) => Math.min(times * 200, 2000),
    ...overrides,
  };

  if (config.cluster) {
    return new Cluster([{ host: config.host, port: config.port }], {
      // Required for AWS ElastiCache with TLS (hostnames must not be resolved).
      dnsLookup: (address, callback) => callback(null, address),
      redisOptions: options,
      enableOfflineQueue: overrides.enableOfflineQueue,
    });
  }
  return new Redis({ host: config.host, port: config.port, ...options });
}
