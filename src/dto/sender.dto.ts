/**
 * Validated inputs of SenderService (proto/communication_hub/v1/sender.proto).
 */

import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { NotificationChannel, SENDER_CHANNELS, SenderRuleMatch } from '../constant/index.js';
import { IsSenderValueForChannel } from '../validator/sender.validator.js';

const CHANNEL_MESSAGE = { message: 'channel must be CHANNEL_EMAIL or CHANNEL_SMS (push has no sender)' };

export class CreateSenderDto {
  @IsIn(SENDER_CHANNELS, CHANNEL_MESSAGE)
  channel: NotificationChannel;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @IsSenderValueForChannel()
  value: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsUUID()
  providerConfigId?: string;

  @IsBoolean()
  isDefault: boolean;
}

export class UpdateSenderDto {
  @IsUUID()
  id: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  // "" unpins the provider.
  @IsOptional()
  @ValidateIf((o: UpdateSenderDto) => o.providerConfigId !== '')
  @IsUUID()
  providerConfigId?: string;
}

export class ListSendersDto {
  @IsOptional()
  @IsIn(SENDER_CHANNELS, CHANNEL_MESSAGE)
  channel?: NotificationChannel;
}

export class CreateSenderRuleDto {
  @IsIn(SENDER_CHANNELS, CHANNEL_MESSAGE)
  channel: NotificationChannel;

  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsIn(Object.values(SenderRuleMatch), { message: 'match must be ANY, RECIPIENT_PREFIX or RECIPIENT_DOMAIN' })
  match: SenderRuleMatch;

  @ValidateIf((o: CreateSenderRuleDto) => o.match !== SenderRuleMatch.Any)
  @IsString()
  @IsNotEmpty({ message: 'match_value is required for RECIPIENT_PREFIX and RECIPIENT_DOMAIN rules' })
  @MaxLength(255)
  matchValue?: string;

  @IsUUID()
  senderId: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priority: number;
}

export class SenderIdDto {
  @IsUUID()
  id: string;
}
