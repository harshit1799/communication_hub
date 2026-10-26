/**
 * E2E harness: boots the full application (gRPC server + queue workers) on
 * a free port and gives tests a promise-based gRPC client built from the
 * same .proto files and loader options as the server.
 *
 *   const hub = await startHub();
 *   const { notification } = await hub.call('NotificationService', 'SendNotification', { notification }, hub.tenantMeta(key));
 *   await hub.expectError(hub.call(...), status.NOT_FOUND, 'NOTIFICATION_NOT_FOUND');
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ConfigService } from '@nestjs/config';
import { INestMicroservice } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer } from 'node:net';
import { AppModule, ObserveInstrument } from '../../src/app.module.js';
import { AppConfig } from '../../src/config/configuration.js';
import { buildGrpcOptions, PROTO_FILES, PROTO_LOADER_OPTIONS } from '../../src/grpc/grpc.options.js';

/** Admin metadata matching ADMIN_API_KEY in vitest.config.e2e.ts. */
export const ADMIN_KEY = 'e2e-admin-key-0123456789abcdef0123456789';

type Service =
  | 'NotificationService'
  | 'TemplateService'
  | 'SenderService'
  | 'DeviceService'
  | 'InboxService'
  | 'ProviderAdminService'
  | 'TenantAdminService';

/** A loosely typed response: tests assert on shapes, not on generated types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = Record<string, any>;

export interface Hub {
  moduleRef: TestingModule;
  app: INestMicroservice;
  // host:port of the gRPC server.
  address: string;
  call(service: Service, method: string, request: object, metadata?: grpc.Metadata): Promise<Msg>;
  /** Asserts the call fails with this gRPC code and error-type trailer. */
  expectError(promise: Promise<unknown>, code: grpc.status, type: string): Promise<grpc.ServiceError>;
  admin(): grpc.Metadata;
  tenant(apiKey: string, extra?: Record<string, string>): grpc.Metadata;
  /** Creates a tenant (with starter templates) and returns its id and API key. */
  createTenant(settings?: { appName?: string }): Promise<{ id: string; key: string }>;
  /** Polls until the notification has left the in-flight states. */
  waitForFinal(apiKey: string, id: string): Promise<{ notification: Msg; attempts: Msg[] }>;
  close(): Promise<void>;
}

/** A free TCP port on localhost. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const IN_FLIGHT = ['NOTIFICATION_STATUS_QUEUED', 'NOTIFICATION_STATUS_PROCESSING', 'NOTIFICATION_STATUS_RETRYING'];

export async function startHub(): Promise<Hub> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const config = moduleRef.get(ConfigService).getOrThrow<AppConfig>('app');
  const port = await freePort();
  const app = moduleRef.createNestMicroservice({ ...buildGrpcOptions({ ...config, grpc: { ...config.grpc, port } }), instrument: ObserveInstrument });
  await app.listen();

  const definition = protoLoader.loadSync(PROTO_FILES, PROTO_LOADER_OPTIONS);
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    communication_hub: { v1: Record<Service, grpc.ServiceClientConstructor> };
  };
  const clients = new Map<Service, grpc.Client>();
  const client = (service: Service) => {
    if (!clients.has(service)) {
      clients.set(service, new pkg.communication_hub.v1[service](`127.0.0.1:${port}`, grpc.credentials.createInsecure()));
    }
    return clients.get(service)! as unknown as Record<string, grpc.requestCallback<Msg> & ((...args: unknown[]) => void)>;
  };

  const meta = (values: Record<string, string>) => {
    const m = new grpc.Metadata();
    for (const [k, v] of Object.entries(values)) m.set(k, v);
    return m;
  };

  const hub: Hub = {
    moduleRef,
    app,
    address: `127.0.0.1:${port}`,
    call: (service, method, request, metadata = new grpc.Metadata()) =>
      new Promise((resolve, reject) => {
        client(service)[method](request, metadata, (err: grpc.ServiceError | null, res: Msg) => (err ? reject(err) : resolve(res)));
      }),
    async expectError(promise, code, type) {
      const err = (await promise.then(
        () => {
          throw new Error(`expected ${grpc.status[code]} ${type}, but the call succeeded`);
        },
        (e: grpc.ServiceError) => e,
      )) as grpc.ServiceError;
      expect({ code: grpc.status[err.code], type: err.metadata?.get('error-type')[0] }).toEqual({ code: grpc.status[code], type });
      return err;
    },
    admin: () => meta({ 'x-admin-key': ADMIN_KEY }),
    tenant: (apiKey, extra = {}) => meta({ 'x-api-key': apiKey, ...extra }),
    async createTenant(settings) {
      const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
      const res = await hub.call('TenantAdminService', 'CreateTenant', { name: 'E2E', slug, settings }, hub.admin());
      return { id: res.tenant.id as string, key: res.apiKey.key as string };
    },
    async waitForFinal(apiKey, id) {
      for (let i = 0; i < 100; i++) {
        const res = await hub.call('NotificationService', 'GetNotification', { id }, hub.tenant(apiKey));
        if (!IN_FLIGHT.includes(res.notification.status)) return { notification: res.notification, attempts: res.attempts };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`notification ${id} did not finish`);
    },
    async close() {
      for (const c of clients.values()) c.close();
      await app.close();
    },
  };
  return hub;
}

/** google.protobuf.Struct from a plain object (string/number/bool values). */
export function struct(obj: Record<string, string | number | boolean>) {
  return {
    fields: Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k,
        typeof v === 'number' ? { numberValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v },
      ]),
    ),
  };
}

/** Plain object from a decoded google.protobuf.Struct (flat values only). */
export function unstruct(s: Msg | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  return Object.fromEntries(Object.entries(s.fields ?? {}).map(([k, v]) => [k, (v as Msg)[(v as Msg).kind]]));
}

/** google.protobuf.Timestamp. */
export const timestamp = (date: Date) => ({ seconds: String(Math.floor(date.getTime() / 1000)), nanos: 0 });
