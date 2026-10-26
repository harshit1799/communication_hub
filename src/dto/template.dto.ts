/**
 * Validated inputs of TemplateService (proto/communication_hub/v1/template.proto).
 * Channel-specific content rules (email needs a subject, ...) are checked
 * by TemplateService, which also compiles the Handlebars source.
 */

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CursorPaginationDto } from '../common/dtos/common.dtos.js';
import { LIMITS, NotificationChannel, TEMPLATE_NAME_REGEX } from '../constant/index.js';

export class TemplateContentDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.TEMPLATE_PART_MAX)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.TEMPLATE_PART_MAX)
  html?: string;
}

export class CreateTemplateDto {
  @IsEnum(NotificationChannel, { message: 'channel must be CHANNEL_EMAIL, CHANNEL_SMS or CHANNEL_PUSH' })
  channel: NotificationChannel;

  @Matches(TEMPLATE_NAME_REGEX, { message: 'name may only contain lowercase letters, digits and dashes' })
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ValidateNested()
  @Type(() => TemplateContentDto)
  content: TemplateContentDto;
}

export class CreateTemplateVersionDto {
  @IsUUID()
  templateId: string;

  @ValidateNested()
  @Type(() => TemplateContentDto)
  content: TemplateContentDto;

  @IsBoolean()
  activate: boolean;
}

export class ActivateTemplateVersionDto {
  @IsUUID()
  templateId: string;

  @IsInt()
  @Min(1)
  version: number;
}

export class PreviewTemplateDto {
  @IsUUID()
  templateId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class ListTemplatesDto extends CursorPaginationDto {
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @IsBoolean()
  includeArchived: boolean;
}

export class TemplateIdDto {
  @IsUUID()
  id: string;
}
