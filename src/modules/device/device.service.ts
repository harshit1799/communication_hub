/**
 * Push token registry: apps register their FCM token per user so the hub
 * can push to a user without the caller tracking devices.
 */

import { Injectable } from '@nestjs/common';
import { RegisterDeviceDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { DeviceToken } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { DeviceRepository } from './device.repository.js';

/** Device registry logic, scoped to one tenant per call. */
@Injectable()
export class DeviceService {
  constructor(private readonly devices: DeviceRepository) {}

  /** Upserts the token for the user and returns the stored device. */
  register(tenantId: string, dto: RegisterDeviceDto): Promise<DeviceToken> {
    return this.devices.register({ tenantId, ...dto });
  }

  /** Deletes the token. Throws DEVICE_NOT_FOUND if it doesn't exist. */
  async unregister(tenantId: string, token: string): Promise<void> {
    if (!(await this.devices.remove(tenantId, token))) {
      throw new AppException(ERROR.DEVICE_NOT_FOUND);
    }
  }

  /** All devices of a user, newest first. */
  list(tenantId: string, userId: string): Promise<DeviceToken[]> {
    return this.devices.findByUser(tenantId, userId);
  }
}
