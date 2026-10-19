/**
 * Data access for the `device_tokens` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DevicePlatform } from '../../constant/index.js';
import { DeviceToken } from '../../models/index.js';

/**
 * Max devices reached by one push-to-user (most recent first), so one user
 * can't trigger an unbounded push batch.
 */
const MAX_DEVICES_PER_USER = 50;

/** All queries are scoped by tenant id. */
@Injectable()
export class DeviceRepository {
  constructor(@InjectRepository(DeviceToken) private readonly devices: Repository<DeviceToken>) {}

  /**
   * Registers a token, or re-assigns it if it already exists (e.g. another
   * user logged in on the same phone). Single atomic upsert, race-free.
   */
  async upsert(input: {
    tenantId: string;
    userId: string;
    token: string;
    platform: DevicePlatform;
  }): Promise<DeviceToken> {
    await this.devices.upsert(
      { ...input, isActive: true, lastSeenAt: new Date() },
      { conflictPaths: ['tenantId', 'token'] },
    );
    return this.devices.findOneByOrFail({ tenantId: input.tenantId, token: input.token });
  }

  /** Active tokens of a user, newest first. */
  async activeTokens(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.devices.find({
      select: { token: true },
      where: { tenantId, userId, isActive: true },
      order: { lastSeenAt: 'DESC' },
      take: MAX_DEVICES_PER_USER,
    });
    return rows.map((r) => r.token);
  }

  /** Every device of a user (active or not), newest first. */
  findByUser(tenantId: string, userId: string): Promise<DeviceToken[]> {
    return this.devices.find({ where: { tenantId, userId }, order: { lastSeenAt: 'DESC' } });
  }

  /** Tokens FCM reported as dead. */
  async deactivate(tenantId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.devices.update({ tenantId, token: In(tokens) }, { isActive: false });
  }

  /** Deletes a token. Returns false if nothing was deleted. */
  async remove(tenantId: string, token: string): Promise<boolean> {
    const result = await this.devices.delete({ tenantId, token });
    return (result.affected ?? 0) > 0;
  }
}
