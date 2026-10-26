/**
 * Dependency checks shared by the gRPC health service and the ops HTTP
 * endpoints. Liveness never touches dependencies (a database blip must not
 * get pods restarted); readiness needs Postgres and Redis.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from '../../utils/redis/redis.service.js';
import { NotificationQueue } from '../notification/notification.queue.js';

// Never let a hung dependency hang a probe.
const withTimeout = <T>(promise: Promise<T>, ms = 2000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

export interface Readiness {
  ready: boolean;
  database: 'up' | 'down';
  redis: 'up' | 'down';
  queues?: { name: string; waiting: number; delayed: number; active: number; failed: number }[];
}

@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly queue: NotificationQueue,
  ) {}

  /** Postgres + Redis reachable, plus queue depth when they are. */
  async readiness(): Promise<Readiness> {
    const [database, redis] = await Promise.all([
      withTimeout(this.dataSource.query('SELECT 1')).then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      withTimeout(this.redis.ping()).then(
        (ok) => (ok ? ('up' as const) : ('down' as const)),
        () => 'down' as const,
      ),
    ]);
    if (database !== 'up' || redis !== 'up') return { ready: false, database, redis };
    const queues = await withTimeout(this.queue.depth()).catch(() => undefined);
    return { ready: true, database, redis, queues };
  }
}
