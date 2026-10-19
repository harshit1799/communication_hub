/**
 * Health checks for load balancers and Kubernetes probes.
 *
 *   GET /api/health        liveness: the process is up (no dependencies, so
 *                          a database blip doesn't get pods restarted)
 *   GET /api/health/ready  readiness: Postgres and Redis reachable, plus
 *                          queue depth for dashboards
 */

import { Controller, Get, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { ApiEnvelope, ApiErrors, Public, ResponseMessage } from '../../decorator/index.js';
import { AppException } from '../../exceptions/index.js';
import { ERROR, SUCCESS } from '../../response/response.js';
import { RedisService } from '../../utils/redis/redis.service.js';
import { NotificationQueue } from '../notification/notification.queue.js';

/** Body of the liveness probe. */
class LivenessDto {
  @ApiProperty({ example: 'ok' }) status: string;
  @ApiProperty({ example: 12.34, description: 'Process uptime in seconds' }) uptime: number;
}

/** Job counts of one delivery queue. */
class QueueDepthDto {
  @ApiProperty() name: string;
  @ApiProperty() waiting: number;
  @ApiProperty() delayed: number;
  @ApiProperty() active: number;
  @ApiProperty() failed: number;
}

/** Body of the readiness probe. */
class ReadinessDto {
  @ApiProperty({ example: 'up' }) database: string;
  @ApiProperty({ example: 'up' }) redis: string;
  @ApiProperty({ type: [QueueDepthDto] }) queues: QueueDepthDto[];
}

// Never let a hung dependency hang the probe.
const withTimeout = <T>(promise: Promise<T>, ms = 2000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

/** Public, unthrottled and excluded from request logs. */
@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly queue: NotificationQueue,
  ) {}

  /** Liveness: always 200 while the process can serve requests. */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiEnvelope(LivenessDto)
  @ResponseMessage(SUCCESS.HEALTHY)
  live(): LivenessDto {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * Readiness: 503 when Postgres or Redis is unreachable, so the load
   * balancer stops routing to this instance.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (Postgres, Redis, queue depth)' })
  @ApiEnvelope(ReadinessDto)
  @ApiErrors(HttpStatus.SERVICE_UNAVAILABLE)
  @ResponseMessage(SUCCESS.HEALTHY)
  async ready(): Promise<ReadinessDto> {
    const [database, redis] = await Promise.all([
      withTimeout(this.dataSource.query('SELECT 1')).then(() => 'up', () => 'down'),
      withTimeout(this.redis.ping()).then((ok) => (ok ? 'up' : 'down'), () => 'down'),
    ]);
    if (database !== 'up' || redis !== 'up') {
      throw new AppException(ERROR.SERVICE_UNAVAILABLE, { database, redis });
    }
    const queues = await Promise.all(
      this.queue.all().map(async (q) => {
        const counts = await withTimeout(q.getJobCounts('waiting', 'delayed', 'active', 'failed'));
        return {
          name: q.name,
          waiting: counts.waiting ?? 0,
          delayed: counts.delayed ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
    return { database, redis, queues };
  }
}
