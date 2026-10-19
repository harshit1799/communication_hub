/**
 * Swagger helper: documents a response as the standard envelope with the
 * given DTO (or array of DTOs) in `data`.
 *
 *   @ApiEnvelope(NotificationResponseDto, { status: 202 })
 */

import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/** Documents a success response wrapped in the standard envelope. */
export function ApiEnvelope(
  model: Type<unknown>,
  options: { status?: HttpStatus; isArray?: boolean; description?: string } = {},
) {
  const ref = { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      description: options.description,
      schema: {
        type: 'object',
        properties: {
          statusCode: { type: 'number', example: options.status ?? 200 },
          type: { type: 'string', example: 'OK' },
          message: { type: 'string', example: 'Success' },
          data: options.isArray ? { type: 'array', items: ref } : ref,
        },
      },
    }),
  );
}

/** Documents the standard error envelope for the given status codes. */
export function ApiErrors(...statuses: HttpStatus[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        schema: {
          type: 'object',
          properties: {
            statusCode: { type: 'number', example: status },
            type: { type: 'string', example: HttpStatus[status] },
            message: { type: 'string' },
            data: { type: 'object' },
          },
        },
      }),
    ),
  );
}
