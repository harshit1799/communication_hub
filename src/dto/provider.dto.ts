/**
 * Validated inputs of ProviderService (proto/communication_hub/v1/provider.proto).
 * Per-provider settings/credentials rules: modules/provider/provider.factory.ts.
 */

import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { NotificationChannel } from '../constant/index.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/;
const NAME_MESSAGE = { message: 'name must be 2-100 lowercase letters, digits or dashes' };

export class CreateProviderDto {
  @IsEnum(NotificationChannel, { message: 'channel must be CHANNEL_EMAIL, CHANNEL_SMS or CHANNEL_PUSH' })
  channel: NotificationChannel;

  @IsString()
  @IsNotEmpty()
  provider: string;

  @Matches(NAME, NAME_MESSAGE)
  name: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priority: number;

  @IsObject()
  settings: Record<string, string>;

  @IsObject()
  credentials: Record<string, string>;

  // Named From addresses: { billing: "Acme Billing <billing@acme.com>", ... }.
  @IsObject()
  fromAddresses: Record<string, string>;
}

export class UpdateProviderDto {
  @IsUUID()
  id: string;

  @IsOptional()
  @Matches(NAME, NAME_MESSAGE)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  // Merged into the stored settings ("" removes a key).
  @IsOptional()
  @IsObject()
  settings?: Record<string, string>;

  // Replaces the stored credentials when given.
  @IsOptional()
  @IsObject()
  credentials?: Record<string, string>;

  // Merged into the stored names ("" removes a name).
  @IsOptional()
  @IsObject()
  fromAddresses?: Record<string, string>;
}

export class ListProvidersDto {
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;
}

export class ProviderIdDto {
  @IsUUID()
  id: string;
}
