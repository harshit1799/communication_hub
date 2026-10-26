/**
 * Pagination shared by list RPCs.
 *
 * Lists use cursor (keyset) pagination instead of page numbers: the cost of
 * fetching a page stays constant however deep the client scrolls, and rows
 * inserted meanwhile don't shift pages.
 */

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LIMITS } from '../../constant/index.js';

/** Pagination input shared by list RPCs (PageRequest). */
export class CursorPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITS.PAGE_SIZE_MAX)
  limit: number = LIMITS.PAGE_SIZE_DEFAULT;

  @IsOptional()
  @IsString()
  cursor?: string;
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
