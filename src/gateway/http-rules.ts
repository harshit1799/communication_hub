/**
 * REST routes from the `google.api.http` annotations in the protos
 * (the standard used by grpc-gateway and Envoy transcoding):
 *
 *   rpc GetNotification(NotificationRef) returns (NotificationDetails) {
 *     option (google.api.http) = { get: "/v1/notifications/{id}" };
 *   }
 *
 * Request binding: {path} params -> fields; `body: "*"` -> the whole request
 * from the JSON body, `body: "field"` -> that field; every other field from
 * the query string (nested with dots: ?page.limit=10).
 */

import protobuf from 'protobufjs';
import { bindParam, fieldToMessage, JsonMappingError, jsonToMessage } from './proto-json.js';

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpBinding {
  verb: HttpVerb;
  // "/v1/notifications/{id}" as written in the proto.
  template: string;
  // "*", a request field name, or undefined (no body).
  body?: string;
  // Field paths bound from the URL path, in order ("user_id", "id").
  pathParams: string[];
  regex: RegExp;
  // Success status: 201 create, 202 accepted (async send), 204 empty delete, else 200.
  successStatus: number;
}

const VERBS: HttpVerb[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** The method's google.api.http rule, or undefined when it has none. */
export function httpBinding(method: protobuf.Method, prefix: string): HttpBinding | undefined {
  const parsed = (method.parsedOptions ?? []) as Record<string, unknown>[];
  const option = parsed.find((o) => '(google.api.http)' in o)?.['(google.api.http)'] as Record<string, string> | undefined;
  if (!option) return undefined;
  const verb = VERBS.find((v) => typeof option[v.toLowerCase()] === 'string');
  if (!verb) return undefined;
  const template = option[verb.toLowerCase()];
  const pathParams: string[] = [];
  const pattern = template
    .split('/')
    .map((segment) => {
      const param = /^\{([\w.]+)\}$/.exec(segment);
      if (!param) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pathParams.push(param[1]);
      return '([^/]+)';
    })
    .join('/');
  const emptyResponse = method.resolvedResponseType?.fullName === '.google.protobuf.Empty';
  const successStatus =
    method.name.startsWith('Send') ? 202 : method.name.startsWith('Create') ? 201 : verb === 'DELETE' && emptyResponse ? 204 : 200;
  return { verb, template, body: option.body || undefined, pathParams, regex: new RegExp(`^${prefix}${pattern}$`), successStatus };
}

/** Number of literal segments: more specific routes are matched first. */
export const specificity = (b: HttpBinding) => b.template.split('/').filter((s) => s && !s.startsWith('{')).length;

/**
 * Builds the gRPC request message from the HTTP request. `pathValues` are
 * the regex captures, in `binding.pathParams` order.
 */
export function buildRequest(
  type: protobuf.Type,
  binding: HttpBinding,
  pathValues: string[],
  query: URLSearchParams,
  body: unknown,
): Record<string, unknown> {
  let message: Record<string, unknown> = {};
  if (binding.body === '*') {
    message = jsonToMessage(type, body);
  } else if (binding.body) {
    const field = type.fields[binding.body.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())];
    if (field && body !== undefined && body !== null) message[field.name] = fieldToMessage(field, body, binding.body);
  } else if (body !== undefined && body !== null && !(typeof body === 'object' && Object.keys(body).length === 0)) {
    throw new JsonMappingError(`${binding.verb} ${binding.template} takes no request body`);
  }

  // Query string: every field not bound to the path or the body.
  if (binding.body !== '*') {
    for (const key of new Set(query.keys())) {
      if (binding.pathParams.includes(key)) throw new JsonMappingError(`"${key}" is a path parameter`);
      bindParam(type, message, key, query.getAll(key));
    }
  }

  // Path parameters win over anything in the body.
  binding.pathParams.forEach((param, i) => {
    let value: string;
    try {
      value = decodeURIComponent(pathValues[i]);
    } catch {
      throw new JsonMappingError(`path parameter "${param}" is not valid URL encoding`);
    }
    bindParam(type, message, param, [value]);
  });
  return message;
}
