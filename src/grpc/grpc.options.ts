/**
 * gRPC server configuration: which .proto files are served, how messages
 * are decoded, size limits, keepalive and optional server reflection.
 *
 * Loader options (the contract every controller relies on):
 *   keepCase false   snake_case proto fields become camelCase in JS
 *   enums String     enums arrive and are sent as names (CHANNEL_EMAIL)
 *   longs String     int64 / Timestamp.seconds as strings (no precision loss)
 *   defaults false   unset fields are absent, so "not given" is detectable
 *   arrays/objects   repeated fields are [] and maps {} when absent
 *   oneofs true      google.protobuf.Value exposes which `kind` is set
 */

import { ReflectionService } from '@grpc/reflection';
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { AppConfig } from '../config/configuration.js';

/** Repository /proto, from src/grpc (tests) and dist/grpc (build) alike. */
export const PROTO_DIR = join(import.meta.dirname, '..', '..', 'proto');

export const PROTO_FILES = [
  'communication_hub/v1/notification.proto',
  'communication_hub/v1/template.proto',
  'communication_hub/v1/sender.proto',
  'communication_hub/v1/provider.proto',
  'communication_hub/v1/tenant.proto',
  'communication_hub/v1/device.proto',
  'communication_hub/v1/inbox.proto',
  'grpc/health/v1/health.proto',
];

export const PROTO_PACKAGES = ['communication_hub.v1', 'grpc.health.v1'];

/** Fully qualified service names (health checks per service). */
export const GRPC_SERVICES = [
  'communication_hub.v1.NotificationService',
  'communication_hub.v1.TemplateService',
  'communication_hub.v1.SenderService',
  'communication_hub.v1.DeviceService',
  'communication_hub.v1.InboxService',
  'communication_hub.v1.ProviderAdminService',
  'communication_hub.v1.TenantAdminService',
];

export const PROTO_LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: false,
  arrays: true,
  objects: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

/** Options for NestFactory.createMicroservice / connectMicroservice. */
export function buildGrpcOptions(app: AppConfig): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      url: `0.0.0.0:${app.grpc.port}`,
      package: PROTO_PACKAGES,
      protoPath: PROTO_FILES,
      loader: PROTO_LOADER_OPTIONS,
      maxReceiveMessageLength: app.grpc.maxMessageBytes,
      maxSendMessageLength: app.grpc.maxMessageBytes,
      keepalive: {
        // Ping idle connections so load balancers don't silently drop them.
        keepaliveTimeMs: 60_000,
        keepaliveTimeoutMs: 20_000,
        keepalivePermitWithoutCalls: 1,
      },
      // Finish in-flight calls on shutdown instead of cutting them off.
      gracefulShutdown: true,
      onLoadPackageDefinition: (definition, server) => {
        if (app.grpc.reflection) new ReflectionService(definition).addToServer(server);
      },
    },
  };
}
