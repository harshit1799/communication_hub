/**
 * Push token registry: apps register their FCM token per user so the hub
 * can push to a user without the caller tracking devices.
 */

import { Injectable } from '@nestjs/common';
import { DeviceResponseDto, RegisterDeviceDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { DeviceToken } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { DeviceRepository } from './device.repository.js';

/** Device registry logic, scoped to one tenant per call. */
@Injectable()
export class DeviceService {
  constructor(private readonly devices: DeviceRepository) {}

  /** Upserts the token for the user and returns the stored device. */
  async register(tenantId: string, dto: RegisterDeviceDto): Promise<DeviceResponseDto> {
    return this.toDto(await this.devices.register({ tenantId, ...dto }));
  }

  /** Deletes the token. Throws DEVICE_NOT_FOUND if it doesn't exist. */
  async unregister(tenantId: string, token: string): Promise<void> {
    if (!(await this.devices.remove(tenantId, token))) {
      throw new AppException(ERROR.DEVICE_NOT_FOUND);
    }
  }

  /** All devices of a user, newest first. */
  async list(tenantId: string, userId: string): Promise<DeviceResponseDto[]> {
    return (await this.devices.findByUser(tenantId, userId)).map((d) => this.toDto(d));
  }

  /** Maps an entity to the public response shape. */
  private toDto(d: DeviceToken): DeviceResponseDto {
    return {
      id: d.id,
      userId: d.userId,
      token: d.token,
      platform: d.platform,
      isActive: d.isActive,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    };
  }
}
