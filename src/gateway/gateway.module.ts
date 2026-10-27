/**
 * Runs the HTTP/JSON gateway + Swagger UI (src/gateway/http-gateway.ts) in
 * the api / all roles, forwarding to this process's gRPC server. Disabled
 * with HTTP_PORT=0 and in the worker role.
 */

import { Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration.js';
import { AppRole } from '../constant/index.js';
import { errorMessage } from '../utils/appUtils.js';
import { HttpGateway } from './http-gateway.js';

@Injectable()
export class HttpGatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('HttpGateway');
  private gateway?: HttpGateway;

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap() {
    const app = this.config.getOrThrow<AppConfig>('app');
    if (app.role === AppRole.Worker || app.http.port === 0) return;
    this.gateway = new HttpGateway({
      grpcTarget: `127.0.0.1:${app.grpc.port}`,
      port: app.http.port,
      maxBodyBytes: app.http.maxBodyBytes,
      title: app.name,
      swagger: app.http.swagger,
      onError: (err) => this.logger.error(`Gateway error: ${errorMessage(err)}`),
    });
    const port = await this.gateway.start();
    this.logger.log(
      `REST gateway on :${port} (/api/v1/...)` +
        (app.http.swagger.enabled ? `; Swagger UI at http://localhost:${port}${app.http.swagger.path}` : ''),
    );
  }

  async onApplicationShutdown() {
    await this.gateway?.stop();
  }
}

@Module({ providers: [HttpGatewayService] })
export class GatewayModule {}
