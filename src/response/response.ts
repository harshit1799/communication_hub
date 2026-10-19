/**
 * Response message types, same convention as the backend service: every
 * response carries a machine-readable `type`, which i18n/<lang>/messages.json
 * translates into the human-readable `message`.
 */

import { HttpStatus } from '@nestjs/common';

/** Success types, set on handlers with @ResponseMessage(). */
export const SUCCESS = {
  OK: 'OK',
  // Notifications
  NOTIFICATION_ACCEPTED: 'NOTIFICATION_ACCEPTED',
  NOTIFICATIONS_ACCEPTED: 'NOTIFICATIONS_ACCEPTED',
  NOTIFICATION_LISTING: 'NOTIFICATION_LISTING',
  NOTIFICATION_DETAILS: 'NOTIFICATION_DETAILS',
  NOTIFICATION_RETRIED: 'NOTIFICATION_RETRIED',
  NOTIFICATION_CANCELLED: 'NOTIFICATION_CANCELLED',
  // Devices
  DEVICE_REGISTERED: 'DEVICE_REGISTERED',
  DEVICE_UNREGISTERED: 'DEVICE_UNREGISTERED',
  DEVICE_LISTING: 'DEVICE_LISTING',
  // Tenants (admin)
  TENANT_CREATED: 'TENANT_CREATED',
  TENANT_UPDATED: 'TENANT_UPDATED',
  TENANT_LISTING: 'TENANT_LISTING',
  TENANT_DETAILS: 'TENANT_DETAILS',
  API_KEY_CREATED: 'API_KEY_CREATED',
  API_KEY_LISTING: 'API_KEY_LISTING',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  // Health
  HEALTHY: 'HEALTHY',
};

/** An error type and the HTTP status it is returned with. */
export interface ErrorDefinition {
  type: string;
  status: HttpStatus;
}

/** Error types, thrown with `new AppException(ERROR.X)`. */
export const ERROR = {
  // Generic
  BAD_REQUEST: { type: 'BAD_REQUEST', status: HttpStatus.BAD_REQUEST },
  VALIDATION_ERROR: { type: 'VALIDATION_ERROR', status: HttpStatus.BAD_REQUEST },
  NOT_FOUND: { type: 'NOT_FOUND', status: HttpStatus.NOT_FOUND },
  TOO_MANY_REQUESTS: {
    type: 'TOO_MANY_REQUESTS',
    status: HttpStatus.TOO_MANY_REQUESTS,
  },
  INTERNAL_SERVER_ERROR: {
    type: 'INTERNAL_SERVER_ERROR',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  },
  SERVICE_UNAVAILABLE: {
    type: 'SERVICE_UNAVAILABLE',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
  // Auth
  API_KEY_MISSING: { type: 'API_KEY_MISSING', status: HttpStatus.UNAUTHORIZED },
  API_KEY_INVALID: { type: 'API_KEY_INVALID', status: HttpStatus.UNAUTHORIZED },
  TENANT_INACTIVE: { type: 'TENANT_INACTIVE', status: HttpStatus.FORBIDDEN },
  ADMIN_KEY_INVALID: {
    type: 'ADMIN_KEY_INVALID',
    status: HttpStatus.UNAUTHORIZED,
  },
  ADMIN_DISABLED: { type: 'ADMIN_DISABLED', status: HttpStatus.FORBIDDEN },
  // Notifications
  NOTIFICATION_NOT_FOUND: {
    type: 'NOTIFICATION_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
  },
  TEMPLATE_NOT_FOUND: {
    type: 'TEMPLATE_NOT_FOUND',
    status: HttpStatus.BAD_REQUEST,
  },
  TEMPLATE_RENDER_FAILED: {
    type: 'TEMPLATE_RENDER_FAILED',
    status: HttpStatus.BAD_REQUEST,
  },
  NOTIFICATION_NOT_RETRYABLE: {
    type: 'NOTIFICATION_NOT_RETRYABLE',
    status: HttpStatus.CONFLICT,
  },
  NOTIFICATION_NOT_CANCELLABLE: {
    type: 'NOTIFICATION_NOT_CANCELLABLE',
    status: HttpStatus.CONFLICT,
  },
  // Devices
  DEVICE_NOT_FOUND: { type: 'DEVICE_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  // Tenants
  TENANT_NOT_FOUND: { type: 'TENANT_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  TENANT_SLUG_TAKEN: { type: 'TENANT_SLUG_TAKEN', status: HttpStatus.CONFLICT },
  API_KEY_NOT_FOUND: { type: 'API_KEY_NOT_FOUND', status: HttpStatus.NOT_FOUND },
} satisfies Record<string, ErrorDefinition>;
