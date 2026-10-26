/**
 * Validated inputs of InboxService (proto/communication_hub/v1/inbox.proto).
 */

import { ArrayMaxSize, IsArray, IsBoolean, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { CursorPaginationDto } from '../common/dtos/common.dtos.js';
import { LIMITS } from '../constant/index.js';

export class InboxUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;
}

export class ListInboxMessagesDto extends CursorPaginationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;

  @IsBoolean()
  unreadOnly: boolean;
}

export class MarkInboxMessagesReadDto extends InboxUserDto {
  @IsArray()
  @ArrayMaxSize(LIMITS.INBOX_MARK_MAX)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class InboxMessageRefDto extends InboxUserDto {
  @IsUUID()
  id: string;
}
