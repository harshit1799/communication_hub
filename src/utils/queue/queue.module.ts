/**
 * BullMQ setup: Redis connection, default job options and the queues.
 *
 * Postgres is the source of truth for a notification; a job only carries
 * its id. Jobs are therefore kept in Redis only briefly after they finish,
 * which keeps Redis memory flat no matter how much traffic flows through.
 */

import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { CHANNEL_QUEUE, MAINTENANCE_QUEUE } from '../../constant/index.js';
import { createRedisConnection } from '../redis/redis.connection.js';
import { QueueConnectionLogger } from './queue-connection.logger.js';

/** Registers the three channel queues and the maintenance queue. */
const queues = BullModule.registerQueue(
  ...Object.values(CHANNEL_QUEUE).map((name) => ({ name })),
  { name: MAINTENANCE_QUEUE },
);

/** Global so any module can @InjectQueue() without importing this. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { redis, queue } = config.getOrThrow<AppConfig>('app');
        const prefix = `${redis.keyPrefix}-bull`;
        return {
          // Standalone: BullMQ opens (and closes) its own connections.
          // Cluster: a shared Cluster client, and a {hash-tagged} prefix so
          // all keys of a queue land on the same slot (BullMQ requirement).
          connection: redis.cluster
            ? createRedisConnection(redis, {
                maxRetriesPerRequest: null,
                enableOfflineQueue: true,
              })
            : {
                host: redis.host,
                port: redis.port,
                password: redis.password,
                db: redis.db,
                tls: redis.tls ? {} : undefined,
                maxRetriesPerRequest: null,
              },
          prefix: redis.cluster ? `{${prefix}}` : prefix,
          defaultJobOptions: {
            attempts: queue.attempts,
            // 5s, 10s, 20s, 40s, ... between attempts.
            backoff: { type: 'exponential', delay: queue.backoffMs },
            removeOnComplete: { age: 3600, count: 10_000 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        };
      },
    }),
    queues,
  ],
  providers: [QueueConnectionLogger],
  exports: [queues],
})
export class QueueModule {}
