/**
 * `@ResponseMessage(SUCCESS.X)` sets the `type` (and translated `message`)
 * of a handler's successful response envelope.
 */

import { SetMetadata } from '@nestjs/common';

/** Metadata key read by ResponseInterceptor. */
export const RESPONSE_MESSAGE_KEY = 'response_message';

/** Sets the response `type` of a handler (one of SUCCESS). */
export const ResponseMessage = (type: string) =>
  SetMetadata(RESPONSE_MESSAGE_KEY, type);
