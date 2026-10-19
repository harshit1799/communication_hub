/**
 * Request/response DTOs for /v1/devices (push token registry).
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { DevicePlatform } from '../constant/index.js';

/** Body of POST /v1/devices. */
export class RegisterDeviceDto {
  @ApiProperty({ description: 'Your user id', example: 'user-42' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;

  @ApiProperty({ description: 'FCM registration token from the app' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}

/** Body of DELETE /v1/devices. */
export class UnregisterDeviceDto {
  @ApiProperty({ description: 'FCM registration token to remove' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token: string;
}

/** Query of GET /v1/devices. */
export class ListDevicesDto {
  @ApiProperty({ example: 'user-42' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;
}

/** A registered device as returned by the API. */
export class DeviceResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() userId: string;
  @ApiProperty() token: string;
  @ApiProperty({ enum: DevicePlatform }) platform: DevicePlatform;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) lastSeenAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
}
