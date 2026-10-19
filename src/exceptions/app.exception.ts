/**
 * Business error carrying one of the ERROR definitions. Thrown from services
 * and turned into the standard error body by HttpExceptionFilter:
 *
 *   throw new AppException(ERROR.NOTIFICATION_NOT_FOUND);
 */

import { HttpException } from '@nestjs/common';
import { ErrorDefinition } from '../response/response.js';

/** An HTTP error whose status and `type` come from an ERROR entry. */
export class AppException extends HttpException {
  constructor(
    error: ErrorDefinition,
    // Extra context returned to the client in `data`.
    data?: Record<string, unknown>,
    // Values interpolated into the translated message.
    args?: Record<string, unknown>,
  ) {
    super({ type: error.type, data, args }, error.status);
  }
}
