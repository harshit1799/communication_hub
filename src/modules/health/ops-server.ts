/**
 * Plain HTTP server for operations, on OPS_PORT, in every role (workers
 * have no gRPC port but still need probes and metrics):
 *
 *   GET /health/live    liveness: the process is up (no dependencies)
 *   GET /health/ready   readiness: Postgres + Redis, queue depth (JSON)
 *   GET /metrics        Prometheus exposition format
 *
 * Kept off the public gRPC port on purpose: expose it to the cluster
 * (kubelet, Prometheus) only.
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';
import { AppConfig } from '../../config/configuration.js';
import { errorMessage } from '../../utils/appUtils.js';
import { MetricsService } from '../../utils/metrics/metrics.service.js';
import { HealthService } from './health.service.js';

@Injectable()
export class OpsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Ops');
  private readonly port: number;
  private server?: Server;

  constructor(
    private readonly health: HealthService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.port = config.getOrThrow<AppConfig>('app').opsPort;
  }

  onApplicationBootstrap() {
    // Port 0 disables the server (tests run several apps in one process).
    if (this.port === 0) return;
    this.server = createServer((req, res) => {
      const send = (status: number, body: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      const route = req.method === 'GET' ? req.url?.split('?')[0] : undefined;
      const handle = async () => {
        switch (route) {
          case '/health/live':
            return send(200, JSON.stringify({ status: 'ok', uptime: process.uptime() }));
          case '/health/ready': {
            const readiness = await this.health.readiness();
            return send(readiness.ready ? 200 : 503, JSON.stringify(readiness));
          }
          case '/metrics': {
            const { contentType, body } = await this.metrics.render();
            return send(200, body, contentType);
          }
          default:
            return send(404, JSON.stringify({ error: 'not found' }));
        }
      };
      handle().catch((err: unknown) => send(500, JSON.stringify({ error: errorMessage(err) })));
    });
    this.server.on('error', (err) => this.logger.error(`Ops server error: ${err.message}`));
    this.server.listen(this.port, '0.0.0.0', () =>
      this.logger.log(`Ops endpoints on :${this.port} (/health/live, /health/ready, /metrics)`),
    );
  }

  async onApplicationShutdown() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
