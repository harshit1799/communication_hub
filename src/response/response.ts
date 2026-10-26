/**
 * Error types, same convention as the backend service: every error carries
 * a machine-readable `type` (gRPC trailing metadata `error-type`), which
 * i18n/<lang>/messages.json translates into the status message. `status` is
 * the HTTP-style status; RpcExceptionFilter maps it to a gRPC code.
 */

import { HttpStatus } from '@nestjs/common';

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
    status: HttpStatus.NOT_FOUND,
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
  // Templates
  TEMPLATE_NAME_TAKEN: { type: 'TEMPLATE_NAME_TAKEN', status: HttpStatus.CONFLICT },
  TEMPLATE_VERSION_NOT_FOUND: { type: 'TEMPLATE_VERSION_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  TEMPLATE_ARCHIVED: { type: 'TEMPLATE_ARCHIVED', status: HttpStatus.CONFLICT },
  TEMPLATE_INVALID: { type: 'TEMPLATE_INVALID', status: HttpStatus.BAD_REQUEST },
  // Senders
  SENDER_NOT_FOUND: { type: 'SENDER_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  SENDER_VALUE_TAKEN: { type: 'SENDER_VALUE_TAKEN', status: HttpStatus.CONFLICT },
  SENDER_RULE_NOT_FOUND: { type: 'SENDER_RULE_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  // Providers
  PROVIDER_CONFIG_NOT_FOUND: { type: 'PROVIDER_CONFIG_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  PROVIDER_CONFIG_INVALID: { type: 'PROVIDER_CONFIG_INVALID', status: HttpStatus.BAD_REQUEST },
  PROVIDER_NAME_TAKEN: { type: 'PROVIDER_NAME_TAKEN', status: HttpStatus.CONFLICT },
  // Inbox
  INBOX_MESSAGE_NOT_FOUND: { type: 'INBOX_MESSAGE_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  // Devices
  DEVICE_NOT_FOUND: { type: 'DEVICE_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  // Tenants
  TENANT_NOT_FOUND: { type: 'TENANT_NOT_FOUND', status: HttpStatus.NOT_FOUND },
  TENANT_SLUG_TAKEN: { type: 'TENANT_SLUG_TAKEN', status: HttpStatus.CONFLICT },
  API_KEY_NOT_FOUND: { type: 'API_KEY_NOT_FOUND', status: HttpStatus.NOT_FOUND },
} satisfies Record<string, ErrorDefinition>;
