/**
 * Health module: gRPC health service and the ops HTTP server (probes and
 * Prometheus metrics). Imports NotificationModule for queue depth.
 */

import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { OpsServer } from './ops-server.js';

@Module({
  imports: [NotificationModule],
  controllers: [HealthController],
  providers: [HealthService, OpsServer],
})
export class HealthModule {}
