/**
 * JSON <-> gRPC message conversion for the HTTP gateway, driven by the
 * .proto descriptors (protobufjs reflection), following the proto3 JSON
 * mapping for the types the API uses:
 *
 *   google.protobuf.Timestamp   "2026-12-01T09:00:00Z"
 *   google.protobuf.Struct      a plain JSON object
 *   enums                       their names ("CHANNEL_EMAIL")
 *   int64                       strings
 *   field names                 camelCase (snake_case accepted on input)
 *
 * Output objects have the shape @grpc/proto-loader expects (see
 * PROTO_LOADER_OPTIONS), so the gateway can reuse the same serializers.
 */

import protobuf from 'protobufjs';
import { ProtoStruct, ProtoTimestamp, Struct, Timestamp } from '../grpc/codecs.js';
import { PROTO_DIR, PROTO_FILES } from '../grpc/grpc.options.js';

const STRUCT = '.google.protobuf.Struct';
const TIMESTAMP = '.google.protobuf.Timestamp';

/** Thrown for request bodies that don't match the message type (-> HTTP 400). */
export class JsonMappingError extends Error {}

/** Loads every API proto (with comments, for the OpenAPI descriptions). */
export function loadProtoRoot(): protobuf.Root {
  const root = new protobuf.Root();
  // Resolve imports relative to proto/ (google/protobuf/* are bundled by protobufjs).
  root.resolvePath = (_origin, target) =>
    target.startsWith('google/protobuf/') ? target : `${PROTO_DIR}/${target}`;
  root.loadSync(PROTO_FILES, { keepCase: false, alternateCommentMode: true });
  root.resolveAll();
  return root;
}

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Request JSON -> message object for the gRPC client. */
export function jsonToMessage(type: protobuf.Type, json: unknown, path = ''): Record<string, unknown> {
  if (json === undefined || json === null) return {};
  if (!isObject(json)) throw new JsonMappingError(`${path || 'body'} must be a JSON object`);
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(json)) {
    const field = type.fields[camel(rawKey)];
    const where = path ? `${path}.${rawKey}` : rawKey;
    if (!field) throw new JsonMappingError(`unknown field "${where}" in ${type.name}`);
    if (value === null || value === undefined) continue;
    if (field.map) {
      if (!isObject(value)) throw new JsonMappingError(`${where} must be an object`);
      out[field.name] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fieldToMessage(field, v, `${where}.${k}`)]));
    } else if (field.repeated) {
      if (!Array.isArray(value)) throw new JsonMappingError(`${where} must be an array`);
      out[field.name] = value.map((v, i) => fieldToMessage(field, v, `${where}.${i}`));
    } else {
      out[field.name] = fieldToMessage(field, value, where);
    }
  }
  return out;
}

function fieldToMessage(field: protobuf.Field, value: unknown, where: string): unknown {
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Type) {
    if (resolved.fullName === TIMESTAMP) {
      const date = typeof value === 'string' ? new Date(value) : undefined;
      if (!date || Number.isNaN(date.getTime())) throw new JsonMappingError(`${where} must be an RFC 3339 timestamp, e.g. 2026-12-01T09:00:00Z`);
      return Timestamp.encode(date);
    }
    if (resolved.fullName === STRUCT) {
      if (!isObject(value)) throw new JsonMappingError(`${where} must be a JSON object`);
      return Struct.encode(value);
    }
    return jsonToMessage(resolved, value, where);
  }
  if (resolved instanceof protobuf.Enum) {
    if (typeof value !== 'string' || !(value in resolved.values)) {
      throw new JsonMappingError(`${where} must be one of ${Object.keys(resolved.values).join(', ')}`);
    }
    return value;
  }
  return value;
}

/** gRPC response object -> response JSON (Struct as JSON, Timestamp as ISO string). */
export function messageToJson(type: protobuf.Type, message: unknown): Record<string, unknown> {
  if (!isObject(message)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    const field = type.fields[key];
    if (!field || value === undefined || value === null) continue;
    if (field.map && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fieldToJson(field, v)]));
    } else if (field.repeated && Array.isArray(value)) {
      out[key] = value.map((v) => fieldToJson(field, v));
    } else {
      out[key] = fieldToJson(field, value);
    }
  }
  return out;
}

function fieldToJson(field: protobuf.Field, value: unknown): unknown {
  const resolved = field.resolvedType;
  if (!(resolved instanceof protobuf.Type)) return value;
  if (resolved.fullName === TIMESTAMP) return Timestamp.decode(value as ProtoTimestamp)?.toISOString();
  if (resolved.fullName === STRUCT) return Struct.decode(value as ProtoStruct);
  return messageToJson(resolved, value);
}
