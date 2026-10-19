/**
 * DTOs shared by list endpoints.
 *
 * Lists use cursor (keyset) pagination instead of page numbers: the cost of
 * fetching a page stays constant however deep the client scrolls, and rows
 * inserted meanwhile don't shift pages.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LIMITS } from '../../constant/index.js';

/** Query parameters shared by list endpoints. */
export class CursorPaginationDto {
  @ApiPropertyOptional({ default: LIMITS.PAGE_SIZE_DEFAULT, maximum: LIMITS.PAGE_SIZE_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITS.PAGE_SIZE_MAX)
  limit: number = LIMITS.PAGE_SIZE_DEFAULT;

  @ApiPropertyOptional({ description: '`nextCursor` from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Pagination info returned with every page. */
export class CursorPageMetaDto {
  @ApiProperty({ type: String, nullable: true, description: 'null on the last page' })
  nextCursor: string | null;
}

/**
 * Encodes/decodes the opaque `cursor`: base64url of "<createdAt ISO>|<id>".
 * decode() returns null for malformed input, which the service turns into a 400.
 */
export const Cursor = {
  encode: (createdAt: Date, id: string) =>
    Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url'),
  decode: (cursor: string): { createdAt: Date; id: string } | null => {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
  },
};
