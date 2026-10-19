/**
 * Health module. Imports NotificationModule for queue access, so the
 * readiness probe can report queue depth.
 */

import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { HealthController } from './health.controller.js';

/** Exposes /api/health and /api/health/ready. */
@Module({
  imports: [NotificationModule],
  controllers: [HealthController],
})
export class HealthModule {}
