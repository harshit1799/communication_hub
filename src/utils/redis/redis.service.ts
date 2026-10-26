/**
 * Thin wrapper over the shared ioredis client: namespaced keys, JSON
 * helpers and a health ping. Callers treat Redis as a cache: every method
 * here may throw when Redis is down, and callers decide whether to fail open.
 */

import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import type { RedisConnection } from './redis.connection.js';

/** DI token of the shared ioredis client. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Shared cache client. Closed on shutdown. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');
  private readonly prefix: string;
  // Last reported state, so an outage logs once instead of once per retry.
  private connected = false;

  constructor(
    @Inject(REDIS_CLIENT) readonly client: RedisConnection,
    config: ConfigService,
  ) {
    const redis = config.getOrThrow<AppConfig>('app').redis;
    this.prefix = `${redis.keyPrefix}:`;
    this.logConnectionEvents(
      `${redis.host}:${redis.port}${redis.cluster ? ' (cluster)' : `/${redis.db}`}${redis.tls ? ' over TLS' : ''}`,
    );
  }

  /** Logs connect, disconnect and reconnect of the cache client. */
  private logConnectionEvents(target: string) {
    this.client.on('ready', () => {
      this.logger.log(`${this.connected ? 'Reconnected' : 'Connected'} to ${target} (cache, rate limits, API keys)`);
      this.connected = true;
    });
    this.client.on('error', (err: Error) => {
      if (this.connected) {
        this.logger.warn(`Connection to ${target} lost: ${err.message}. Reconnecting; API keys fall back to Postgres.`);
        this.connected = false;
      } else {
        // Already reported (or never connected): keep retries out of the log.
        this.logger.debug(`Still unreachable at ${target}: ${err.message}`);
      }
    });
    this.client.on('reconnecting', (delay: number) => this.logger.debug(`Reconnecting to ${target} in ${delay}ms`));
    this.client.on('end', () => this.logger.debug(`Connection to ${target} ended`));
    // Not connected within a few seconds of startup: say so once.
    setTimeout(() => {
      if (!this.connected) this.logger.warn(`Not connected to ${target} yet; retrying in the background`);
    }, 5000).unref();
  }

  /** Adds the service namespace to a key. */
  key(key: string): string {
    return this.prefix + key;
  }

  /** Reads and parses a JSON value, or null if missing. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.key(key));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Stores a JSON value with a TTL. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(key), JSON.stringify(value), 'EX', ttlSeconds);
  }

  /**
   * Cache-aside read: the cached value, or `load()` stored for `ttlSeconds`.
   * Redis being down never fails the caller: reads and writes fall back to
   * `load()` (Postgres), logged at debug level so an outage doesn't flood
   * the logs (the connection events above already report it).
   */
  async cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.getJson<T>(key);
      if (hit !== null) return hit;
    } catch (err) {
      this.logger.debug(`Cache read ${key} failed, loading from source: ${(err as Error).message}`);
    }
    const value = await load();
    this.setJson(key, value, ttlSeconds).catch((err: Error) =>
      this.logger.debug(`Cache write ${key} failed: ${err.message}`),
    );
    return value;
  }

  /**
   * Drops cache entries after a configuration change. Failure is logged,
   * not thrown: the entry still expires with its TTL.
   */
  async invalidate(...keys: string[]): Promise<void> {
    try {
      await this.del(...keys);
    } catch (err) {
      this.logger.error(`Cache invalidation failed for ${keys.join(', ')}: ${(err as Error).message}`);
    }
  }

  /** Deletes keys (one command per key, cluster-safe). */
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // One DEL per key: keys may live on different slots in cluster mode.
    await Promise.all(keys.map((k) => this.client.del(this.key(k))));
  }

  /** True if Redis answers PONG (readiness probe). */
  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  /** Nest lifecycle hook: closes the connection, forcing it if needed. */
  async onApplicationShutdown() {
    await this.client.quit().catch(() => this.client.disconnect());
    this.logger.log('Cache connection closed');
  }
}
