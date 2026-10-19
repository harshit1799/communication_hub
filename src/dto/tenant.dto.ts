/**
 * Request/response DTOs for /v1/admin/tenants (admin key required).
 */

import { ApiProperty, ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Per-tenant branding and sender overrides (all optional). */
export class TenantSettingsDto {
  @ApiPropertyOptional({ description: 'Brand name in templates', example: 'Acme' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  appName?: string;

  @ApiPropertyOptional({ description: 'Email "From" (address must be verified with the email provider)', example: 'Acme <no-reply@acme.com>' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  emailFrom?: string;

  @ApiPropertyOptional({ description: 'SMS sender number or alphanumeric id', example: '+14155550100' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  smsFrom?: string;
}

/** Body of POST /v1/admin/tenants. */
export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Inc.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ description: 'Unique, URL-safe identifier', example: 'acme' })
  @Matches(/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/, {
    message: 'slug must be 3-100 lowercase letters, digits or dashes',
  })
  slug: string;

  @ApiPropertyOptional({ type: TenantSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;
}

/** Body of PATCH /v1/admin/tenants/:id. Settings are merged, not replaced. */
export class UpdateTenantDto extends PartialType(PickType(CreateTenantDto, ['name', 'settings'] as const)) {
  @ApiPropertyOptional({ description: 'Inactive tenants are rejected immediately' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body of POST /v1/admin/tenants/:id/api-keys. */
export class CreateApiKeyDto {
  @ApiProperty({ description: 'Label to tell keys apart', example: 'production backend' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: 'Optional expiry (ISO-8601)' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

/** Route parameter `:id`. */
export class TenantIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

/** Route parameters `:id` and `:keyId`. */
export class ApiKeyParamsDto extends TenantIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  keyId: string;
}

/** A tenant as returned by the admin API. */
export class TenantResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: TenantSettingsDto }) settings: TenantSettingsDto;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}

/** An API key's metadata. Never contains the key or its hash. */
export class ApiKeyResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'chk_a1b2c3d4', description: 'First characters of the key' }) prefix: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) lastUsedAt: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) expiresAt: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) revokedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
}

/** A newly issued key: the only response that contains the key itself. */
export class CreatedApiKeyResponseDto extends ApiKeyResponseDto {
  @ApiProperty({ description: 'The full key. Shown only once; store it securely.' })
  key: string;
}

/** Result of creating a tenant: the tenant and its first key. */
export class CreatedTenantResponseDto {
  @ApiProperty({ type: TenantResponseDto }) tenant: TenantResponseDto;
  @ApiProperty({ type: CreatedApiKeyResponseDto }) apiKey: CreatedApiKeyResponseDto;
}
