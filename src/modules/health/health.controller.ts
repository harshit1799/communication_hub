/**
 * grpc.health.v1.Health/Check (public), the standard gRPC health protocol:
 * Kubernetes `grpc` probes, grpc_health_probe and load balancers use it.
 * SERVING when Postgres and Redis are reachable.
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { Public } from '../../decorator/index.js';
import { GRPC_SERVICES } from '../../grpc/grpc.options.js';
import { HealthService } from './health.service.js';

@Public()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @GrpcMethod('Health', 'Check')
  async check(@Payload() req: { service?: string }) {
    if (req.service && !GRPC_SERVICES.includes(req.service)) return { status: 'SERVICE_UNKNOWN' };
    return { status: (await this.health.readiness()).ready ? 'SERVING' : 'NOT_SERVING' };
  }
}
