/**
 * Builds the OpenAPI 3 document for Swagger UI from the .proto files, so
 * the HTTP docs can never drift from the gRPC contract: every RPC with a
 * google.api.http annotation becomes its REST operation (verb, path params,
 * query params, body), e.g. GET /api/v1/notifications/{id}.
 *
 * Descriptions come from the proto comments.
 */

import protobuf from 'protobufjs';
import { METADATA } from '../constant/index.js';
import { httpBinding } from './http-rules.js';

const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (name: string) => name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export const API_PACKAGE = 'communication_hub.v1';
// REST paths in the protos start with /v1: /api/v1/notifications, ...
export const GATEWAY_PREFIX = '/api';

/** Services whose RPCs require x-admin-key instead of x-api-key. */
export const ADMIN_SERVICES = new Set(['TenantAdminService']);

type Schema = Record<string, unknown>;

const SCALARS: Record<string, Schema> = {
  string: { type: 'string' },
  bool: { type: 'boolean' },
  bytes: { type: 'string', format: 'byte' },
  double: { type: 'number', format: 'double' },
  float: { type: 'number', format: 'float' },
  int32: { type: 'integer', format: 'int32' },
  sint32: { type: 'integer', format: 'int32' },
  sfixed32: { type: 'integer', format: 'int32' },
  uint32: { type: 'integer', format: 'int64', minimum: 0 },
  fixed32: { type: 'integer', format: 'int64', minimum: 0 },
  // proto3 JSON: 64-bit integers are strings.
  int64: { type: 'string', format: 'int64' },
  sint64: { type: 'string', format: 'int64' },
  sfixed64: { type: 'string', format: 'int64' },
  uint64: { type: 'string', format: 'uint64' },
  fixed64: { type: 'string', format: 'uint64' },
};

/** Proto comments are `//` lines; keep them readable in Swagger. */
const describe = (comment: string | null | undefined) => (comment ? comment.trim() : undefined);

export function buildOpenApi(root: protobuf.Root, info: { title: string; version: string }): Record<string, unknown> {
  const pkg = root.lookup(API_PACKAGE) as protobuf.Namespace;
  const schemas: Record<string, Schema> = {
    Error: {
      type: 'object',
      description: 'Error body. `code` is the gRPC status, `type` the machine-readable reason (same as gRPC `error-type`).',
      properties: {
        code: { type: 'string', example: 'INVALID_ARGUMENT' },
        type: { type: 'string', example: 'VALIDATION_ERROR' },
        message: { type: 'string', example: 'Request validation failed: recipient must be an E.164 phone number, e.g. +14155550123' },
        data: { type: 'object', additionalProperties: true },
      },
    },
  };

  const refFor = (type: protobuf.Type | protobuf.Enum): Schema => {
    if (type.fullName === '.google.protobuf.Timestamp') return { type: 'string', format: 'date-time' };
    if (type.fullName === '.google.protobuf.Struct') return { type: 'object', additionalProperties: true };
    if (type.fullName === '.google.protobuf.Empty') return { type: 'object' };
    const name = type.name;
    if (!schemas[name]) {
      schemas[name] = {}; // placeholder: breaks recursion
      schemas[name] = type instanceof protobuf.Enum ? enumSchema(type) : messageSchema(type);
    }
    return { $ref: `#/components/schemas/${name}` };
  };

  const enumSchema = (e: protobuf.Enum): Schema => ({
    type: 'string',
    description: describe(e.comment),
    enum: Object.keys(e.values).filter((v) => !v.endsWith('_UNSPECIFIED')),
  });

  const fieldSchema = (field: protobuf.Field): Schema => {
    const value = field.resolvedType ? refFor(field.resolvedType as protobuf.Type) : (SCALARS[field.type] ?? { type: 'string' });
    let schema: Schema = value;
    if (field.map) schema = { type: 'object', additionalProperties: value };
    else if (field.repeated) schema = { type: 'array', items: value };
    const description = describe(field.comment);
    // $ref siblings are ignored in OpenAPI 3.0: wrap to keep the description.
    if (description) schema = '$ref' in schema ? { allOf: [schema], description } : { ...schema, description };
    return schema;
  };

  const messageSchema = (type: protobuf.Type): Schema => ({
    type: 'object',
    description: describe(type.comment),
    additionalProperties: false,
    properties: Object.fromEntries(type.fieldsArray.map((f) => [f.name, fieldSchema(f)])),
  });

  /** Query parameters: every field not in the path / body; nested messages flattened one level ("page.limit"). */
  const queryParams = (type: protobuf.Type, exclude: Set<string>, prefix = ''): Schema[] =>
    type.fieldsArray.flatMap((f) => {
      const name = `${prefix}${toSnake(f.name)}`;
      if (exclude.has(name) || f.map) return [];
      const resolved = f.resolvedType;
      const wkt = resolved && ['.google.protobuf.Timestamp'].includes(resolved.fullName);
      if (resolved instanceof protobuf.Type && !wkt) return prefix || f.repeated ? [] : queryParams(resolved, exclude, `${name}.`);
      const item = resolved ? refFor(resolved as protobuf.Type) : (SCALARS[f.type] ?? { type: 'string' });
      return [
        {
          name,
          in: 'query',
          required: false,
          description: describe(f.comment),
          schema: f.repeated ? { type: 'array', items: item } : item,
          ...(f.repeated ? { style: 'form', explode: true } : {}),
        },
      ];
    });

  /** Request schema for `body: "*"`: the message without the path-bound fields. */
  const bodySchema = (type: protobuf.Type, pathParams: string[]): Schema => {
    if (pathParams.length === 0) return refFor(type);
    const full = messageSchema(type) as { properties: Record<string, Schema> };
    const pathFields = new Set(pathParams.map(toCamel));
    return {
      ...full,
      properties: Object.fromEntries(Object.entries(full.properties).filter(([k]) => !pathFields.has(k))),
    };
  };

  const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted (delivered asynchronously)', 204: 'No Content' };

  const tags: { name: string; description?: string }[] = [];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const service of pkg.nestedArray.filter((n): n is protobuf.Service => n instanceof protobuf.Service)) {
    const admin = ADMIN_SERVICES.has(service.name);
    tags.push({ name: service.name, description: describe(service.comment) });
    for (const method of service.methodsArray) {
      const binding = httpBinding(method, GATEWAY_PREFIX);
      if (!binding) continue;
      const request = method.resolvedRequestType!;
      const response = method.resolvedResponseType!;
      const description = describe(method.comment);
      const pathParams = binding.pathParams.map((name) => {
        const field = request.fields[toCamel(name)];
        return {
          name,
          in: 'path',
          required: true,
          description: describe(field?.comment),
          schema: field ? (field.resolvedType ? refFor(field.resolvedType as protobuf.Type) : (SCALARS[field.type] ?? { type: 'string' })) : { type: 'string' },
        };
      });
      const exclude = new Set([...binding.pathParams, ...(binding.body ? [binding.body] : [])]);
      const query = binding.body === '*' ? [] : queryParams(request, exclude);
      let requestBody: unknown;
      if (binding.body === '*') {
        requestBody = { required: true, content: { 'application/json': { schema: bodySchema(request, binding.pathParams) } } };
      } else if (binding.body) {
        const field = request.fields[toCamel(binding.body)];
        requestBody = { required: true, content: { 'application/json': { schema: refFor(field.resolvedType as protobuf.Type) } } };
      }
      const success = binding.successStatus;
      (paths[`${GATEWAY_PREFIX}${binding.template}`] ??= {})[binding.verb.toLowerCase()] = {
        tags: [service.name],
        operationId: `${service.name}_${method.name}`,
        summary: description?.split('\n')[0] ?? method.name,
        description: `${description ?? ''}\n\ngRPC: \`${API_PACKAGE}.${service.name}/${method.name}\``.trim(),
        security: [{ [admin ? 'adminKey' : 'apiKey']: [] }],
        parameters: [
          ...pathParams,
          ...query,
          { name: METADATA.REQUEST_ID, in: 'header', required: false, schema: { type: 'string' }, description: 'Your trace id; echoed back and written to every log line' },
          { name: METADATA.LANGUAGE, in: 'header', required: false, schema: { type: 'string', example: 'en' }, description: 'Language of error messages' },
        ],
        ...(requestBody ? { requestBody } : {}),
        responses: {
          [success]:
            success === 204
              ? { description: STATUS_TEXT[204] }
              : { description: STATUS_TEXT[success], content: { 'application/json': { schema: refFor(response) } } },
          default: { description: 'Error (HTTP status mapped from the gRPC code)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      };
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: info.title,
      version: info.version,
      description:
        'REST/JSON gateway to the Communication Hub gRPC API (`proto/communication_hub/v1`). ' +
        'Every operation is a gRPC method (named in its description): same validation, auth, rate limits and errors. ' +
        'Reads are GET (filters and pagination as query parameters, e.g. `?page.limit=20&page.cursor=...`), ' +
        'creates POST (201; sends 202, delivery is asynchronous), partial updates PATCH, deletes DELETE (204). ' +
        `Tenant services need the \`${METADATA.API_KEY}\` header, admin services \`${METADATA.ADMIN_KEY}\`. ` +
        'Enums are their proto names (e.g. `CHANNEL_EMAIL`), times RFC 3339 strings, `data` a JSON object.',
    },
    tags,
    paths,
    components: {
      schemas,
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: METADATA.API_KEY, description: 'Tenant API key (chk_...)' },
        adminKey: { type: 'apiKey', in: 'header', name: METADATA.ADMIN_KEY, description: 'ADMIN_API_KEY' },
      },
    },
  };
}
