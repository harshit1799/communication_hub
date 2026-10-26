/**
 * HTTP/JSON gateway in front of the gRPC API, plus Swagger UI.
 *
 *   POST /api/v1/<Service>/<Method>   JSON body -> gRPC call on this process -> JSON
 *   GET  /docs                        Swagger UI (assets from swagger-ui-dist, no CDN)
 *   GET  /docs/openapi.json           OpenAPI 3, generated from proto/
 *
 * The gateway is a gRPC *client* of the local server: requests pass the
 * exact same pipeline (auth, rate limit, validation, errors, logs, metrics)
 * as native gRPC calls, and nothing is implemented twice. Cost: one
 * loopback hop (well under a millisecond).
 *
 * Headers x-api-key, x-admin-key, x-request-id and language become gRPC
 * metadata. Errors map gRPC codes to HTTP statuses with a JSON body
 * { code, type, message, data }.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import protobuf from 'protobufjs';
import { METADATA } from '../constant/index.js';
import { PROTO_FILES, PROTO_LOADER_OPTIONS } from '../grpc/grpc.options.js';
import { safeEqual } from '../utils/appUtils.js';
import { resolveRequestId } from '../utils/request-context.js';
import { API_PACKAGE, buildOpenApi, GATEWAY_PREFIX } from './openapi.js';
import { JsonMappingError, jsonToMessage, loadProtoRoot, messageToJson } from './proto-json.js';

export interface GatewayOptions {
  // host:port of the gRPC server to forward to.
  grpcTarget: string;
  port: number;
  host?: string;
  maxBodyBytes: number;
  // Per-call deadline.
  timeoutMs?: number;
  title: string;
  swagger: { enabled: boolean; path: string; user?: string; pass?: string };
  // Unexpected (non-gRPC) errors, for logging.
  onError?: (err: unknown) => void;
}

/** gRPC status -> HTTP status. */
const HTTP_STATUS: Partial<Record<grpc.status, number>> = {
  [grpc.status.OK]: 200,
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.OUT_OF_RANGE]: 400,
  [grpc.status.UNAUTHENTICATED]: 401,
  [grpc.status.PERMISSION_DENIED]: 403,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.ALREADY_EXISTS]: 409,
  [grpc.status.FAILED_PRECONDITION]: 409,
  [grpc.status.ABORTED]: 409,
  [grpc.status.RESOURCE_EXHAUSTED]: 429,
  [grpc.status.CANCELLED]: 499,
  [grpc.status.UNIMPLEMENTED]: 501,
  [grpc.status.UNAVAILABLE]: 503,
  [grpc.status.DEADLINE_EXCEEDED]: 504,
};

/** Headers forwarded as gRPC metadata. */
const FORWARDED = [METADATA.API_KEY, METADATA.ADMIN_KEY, METADATA.LANGUAGE];

/** Swagger UI files served from node_modules/swagger-ui-dist. */
const SWAGGER_ASSETS: Record<string, string> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'text/javascript; charset=utf-8',
};

interface Route {
  path: string;
  request: protobuf.Type;
  response: protobuf.Type;
  definition: protoLoader.MethodDefinition<object, object>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HttpGateway {
  private readonly routes = new Map<string, Route>();
  private readonly client: grpc.Client;
  private readonly openApi: string;
  private readonly swaggerDir: string;
  private readonly basicAuth?: string;
  private server?: Server;

  constructor(private readonly options: GatewayOptions) {
    const root = loadProtoRoot();
    const definition = protoLoader.loadSync(PROTO_FILES, PROTO_LOADER_OPTIONS);
    for (const service of (root.lookup(API_PACKAGE) as protobuf.Namespace).nestedArray) {
      if (!(service instanceof protobuf.Service)) continue;
      const methods = definition[`${API_PACKAGE}.${service.name}`] as protoLoader.ServiceDefinition;
      for (const method of service.methodsArray) {
        this.routes.set(`${GATEWAY_PREFIX}/${service.name}/${method.name}`, {
          path: `/${API_PACKAGE}.${service.name}/${method.name}`,
          request: method.resolvedRequestType!,
          response: method.resolvedResponseType!,
          definition: methods[method.name] as protoLoader.MethodDefinition<object, object>,
        });
      }
    }
    // One channel for every service (generic client + per-method serializers).
    this.client = new grpc.Client(options.grpcTarget, grpc.credentials.createInsecure());
    this.openApi = JSON.stringify(buildOpenApi(root, { title: options.title, version: '1.0' }));
    this.swaggerDir = createRequire(import.meta.url)('swagger-ui-dist').absolutePath() as string;
    const { user, pass } = options.swagger;
    if (user && pass) this.basicAuth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }

  /** Resolves once listening; returns the bound port (useful with port 0). */
  start(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => this.sendError(res, err));
    });
    // Slowloris protection: whole request (headers + body) within 30s.
    this.server.requestTimeout = 30_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host ?? '0.0.0.0', () => resolve((this.server!.address() as { port: number }).port));
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections();
    this.client.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff');
    const url = (req.url ?? '/').split('?')[0];
    const docs = this.options.swagger.path.replace(/\/$/, '');

    if (this.options.swagger.enabled && (url === docs || url.startsWith(`${docs}/`))) {
      return this.serveDocs(req, res, url.slice(docs.length) || '/');
    }

    const route = this.routes.get(url);
    if (!route) throw new HttpError(404, 'NOT_FOUND', `No route ${req.method} ${url}`);
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST with a JSON body');
    }

    const requestId = resolveRequestId(req.headers[METADATA.REQUEST_ID]);
    res.setHeader(METADATA.REQUEST_ID, requestId);
    const metadata = new grpc.Metadata();
    metadata.set(METADATA.REQUEST_ID, requestId);
    for (const header of FORWARDED) {
      const value = req.headers[header];
      if (typeof value === 'string' && value) metadata.set(header, value);
    }

    let message: Record<string, unknown>;
    try {
      message = jsonToMessage(route.request, await this.readJson(req));
    } catch (err) {
      if (err instanceof JsonMappingError) throw new HttpError(400, 'INVALID_ARGUMENT', err.message);
      throw err;
    }

    const response = await new Promise<object>((resolve, reject) => {
      this.client.makeUnaryRequest(
        route.path,
        route.definition.requestSerialize,
        route.definition.responseDeserialize,
        message,
        metadata,
        { deadline: Date.now() + (this.options.timeoutMs ?? 30_000) },
        (err, value) => (err ? reject(err) : resolve(value ?? {})),
      );
    });
    this.send(res, 200, messageToJson(route.response, response));
  }

  /** Reads and parses the JSON body, enforcing the size limit. */
  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.options.maxBodyBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${this.options.maxBodyBytes} bytes`);
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'Body is not valid JSON');
    }
  }

  private serveDocs(req: IncomingMessage, res: ServerResponse, sub: string): void {
    if (this.basicAuth && !safeEqual(req.headers.authorization ?? '', this.basicAuth)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="docs"' }).end();
      return;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Docs are GET only');
    const base = this.options.swagger.path.replace(/\/$/, '');
    // Everything is served from here: no CDN, no inline script.
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    if (sub === '/' || sub === '/index.html') {
      return this.send(res, 200, this.indexHtml(base), 'text/html; charset=utf-8');
    }
    if (sub === '/openapi.json') return this.send(res, 200, this.openApi, 'application/json');
    if (sub === '/init.js') {
      const script =
        `window.ui = SwaggerUIBundle({ url: ${JSON.stringify(`${base}/openapi.json`)}, dom_id: '#swagger-ui', ` +
        `deepLinking: true, persistAuthorization: true, displayRequestDuration: true, ` +
        `presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: 'StandaloneLayout' });`;
      return this.send(res, 200, script, 'text/javascript; charset=utf-8');
    }
    const asset = sub.slice(1);
    const type = SWAGGER_ASSETS[asset];
    if (!type) throw new HttpError(404, 'NOT_FOUND', 'Unknown docs asset');
    res.setHeader('cache-control', 'public, max-age=86400');
    return this.send(res, 200, readFileSync(join(this.swaggerDir, asset)), type);
  }

  private indexHtml(base: string): string {
    const title = this.options.title.replace(/[<>&"]/g, '');
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} API</title>
    <link rel="stylesheet" href="${base}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${base}/swagger-ui-bundle.js"></script>
    <script src="${base}/swagger-ui-standalone-preset.js"></script>
    <script src="${base}/init.js"></script>
  </body>
</html>`;
  }

  private send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    if (res.headersSent) return;
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type });
    res.end(payload);
  }

  /** gRPC / gateway errors -> { code, type, message, data } with a mapped HTTP status. */
  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof HttpError) {
      return this.send(res, err.status, { code: err.code, type: err.code, message: err.message, data: {} });
    }
    const grpcErr = err as Partial<grpc.ServiceError>;
    if (typeof grpcErr.code === 'number') {
      const type = grpcErr.metadata?.get(METADATA.ERROR_TYPE)[0]?.toString() ?? grpc.status[grpcErr.code];
      const rawData = grpcErr.metadata?.get(METADATA.ERROR_DATA)[0]?.toString();
      let data: unknown = {};
      try {
        data = rawData ? JSON.parse(rawData) : {};
      } catch {
        data = {};
      }
      if (type === 'TOO_MANY_REQUESTS' && typeof (data as { retryAfterSeconds?: number }).retryAfterSeconds === 'number') {
        res.setHeader('retry-after', String((data as { retryAfterSeconds: number }).retryAfterSeconds));
      }
      return this.send(res, HTTP_STATUS[grpcErr.code] ?? 500, {
        code: grpc.status[grpcErr.code],
        type,
        message: grpcErr.details ?? grpcErr.message,
        data,
      });
    }
    this.options.onError?.(err);
    this.send(res, 500, { code: 'INTERNAL', type: 'INTERNAL_SERVER_ERROR', message: 'Gateway error', data: {} });
  }
}
