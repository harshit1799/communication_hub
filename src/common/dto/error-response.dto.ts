/**
 * Standard error response body returned by AllExceptionsFilter.
 * Also used in Swagger so clients can see the error format.
 */

// ApiProperty: documents a property in the OpenAPI/Swagger schema.
import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  // HTTP status code, e.g. 400, 404, 500.
  @ApiProperty({ example: 400 })
  statusCode: number;

  // Short error name, e.g. "Bad Request".
  @ApiProperty({ example: 'Bad Request' })
  error: string;

  // Human-readable message, or a list of messages for validation errors.
  @ApiProperty({
    // Tell Swagger the value can be a string OR an array of strings.
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['recipient must be a string'],
  })
  message: string | string[];

  // The request path that caused the error.
  @ApiProperty({ example: '/api/v1/notifications' })
  path: string;

  // ISO-8601 time at which the error occurred.
  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  timestamp: string;
}
