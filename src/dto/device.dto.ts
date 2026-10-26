/**
 * Validated inputs of DeviceService (proto/communication_hub/v1/device.proto).
 */

import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { DevicePlatform } from '../constant/index.js';

/** RegisterDevice. */
export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token: string;

  @IsEnum(DevicePlatform, { message: 'platform must be DEVICE_PLATFORM_IOS, _ANDROID or _WEB' })
  platform: DevicePlatform;
}

/** UnregisterDevice. */
export class UnregisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token: string;
}

/** ListDevices. */
export class ListDevicesDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;
}
