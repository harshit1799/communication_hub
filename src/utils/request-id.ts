/**
 * Request ids for log correlation. A caller-supplied x-request-id is reused
 * (so one id can be traced across services) if it looks safe; otherwise a
 * UUID is generated. The id is written back onto the request headers so
 * Fastify and the pino HTTP logger agree on the same value.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HEADER } from '../constant/index.js';

/** Accepted format for caller ids; anything else is replaced (log safety). */
const SAFE_ID = /^[\w.-]{1,128}$/;

/** Returns the request id for this request and stores it on the headers. */
export function resolveRequestId(req: { headers: IncomingHttpHeaders }): string {
  const incoming = req.headers[HEADER.REQUEST_ID];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.headers[HEADER.REQUEST_ID] = id;
  return id;
}
