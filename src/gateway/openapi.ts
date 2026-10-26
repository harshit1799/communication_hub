/**
 * Builds the OpenAPI 3 document for Swagger UI from the .proto files, so
 * the HTTP docs can never drift from the gRPC contract: every RPC becomes
 *
 *   POST /api/v1/<Service>/<Method>    body = request message, 200 = response message
 *
 * Descriptions come from the proto comments.
 */

import protobuf from 'protobufjs';
import { METADATA } from '../constant/index.js';

export const API_PACKAGE = 'communication_hub.v1';
export const GATEWAY_PREFIX = '/api/v1';

/** Services whose RPCs require x-admin-key instead of x-api-key. */
export const ADMIN_SERVICES = new Set(['TenantAdminService', 'ProviderAdminService']);

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

  const tags: { name: string; description?: string }[] = [];
  const paths: Record<string, unknown> = {};
  for (const service of pkg.nestedArray.filter((n): n is protobuf.Service => n instanceof protobuf.Service)) {
    const admin = ADMIN_SERVICES.has(service.name);
    tags.push({ name: service.name, description: describe(service.comment) });
    for (const method of service.methodsArray) {
      const request = method.resolvedRequestType!;
      const response = method.resolvedResponseType!;
      const description = describe(method.comment);
      paths[`${GATEWAY_PREFIX}/${service.name}/${method.name}`] = {
        post: {
          tags: [service.name],
          operationId: `${service.name}_${method.name}`,
          summary: description?.split('\n')[0] ?? method.name,
          description: `${description ?? ''}\n\ngRPC: \`${API_PACKAGE}.${service.name}/${method.name}\``.trim(),
          security: [{ [admin ? 'adminKey' : 'apiKey']: [] }],
          parameters: [
            { name: METADATA.REQUEST_ID, in: 'header', required: false, schema: { type: 'string' }, description: 'Your trace id; echoed back and written to every log line' },
            { name: METADATA.LANGUAGE, in: 'header', required: false, schema: { type: 'string', example: 'en' }, description: 'Language of error messages' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: refFor(request) } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: refFor(response) } } },
            default: { description: 'Error (HTTP status mapped from the gRPC code)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
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
        'HTTP/JSON gateway to the Communication Hub gRPC API (`proto/communication_hub/v1`). ' +
        'Every operation is the gRPC method of the same name: same validation, auth, rate limits and errors. ' +
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
