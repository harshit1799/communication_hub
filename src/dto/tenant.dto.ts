/**
 * Validated inputs of TenantAdminService (proto/communication_hub/v1/tenant.proto).
 */

import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

/** Per-tenant branding (all optional). */
export class TenantSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  appName?: string;
}

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @Matches(/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/, {
    message: 'slug must be 3-100 lowercase letters, digits or dashes',
  })
  slug: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;
}

/** Settings are merged, not replaced. */
export class UpdateTenantDto {
  @IsUUID()
  id: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;
}

export class CreateApiKeyDto {
  @IsUUID()
  tenantId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsDate()
  expiresAt?: Date;
}

export class TenantIdDto {
  @IsUUID()
  id: string;
}

export class RevokeApiKeyDto {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  keyId: string;
}
