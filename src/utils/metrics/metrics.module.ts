/** Global metrics module: one Prometheus registry per process. */

import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
