/**
 * Data access for the `device_tokens` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DevicePlatform } from '../../constant/index.js';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { DeviceToken } from '../../models/index.js';

/**
 * Max devices reached by one push-to-user (most recent first), so one user
 * can't trigger an unbounded push batch.
 */
const MAX_DEVICES_PER_USER = 50;

/** Device queries on top of BaseRepository; all scoped by tenant id. */
@Injectable()
export class DeviceRepository extends BaseRepository<DeviceToken> {
  constructor(@InjectRepository(DeviceToken) repository: Repository<DeviceToken>) {
    super(repository);
  }

  /**
   * Registers a token, or re-assigns it if it already exists (e.g. another
   * user logged in on the same phone). Single atomic upsert, race-free.
   */
  async register(input: { tenantId: string; userId: string; token: string; platform: DevicePlatform }): Promise<DeviceToken> {
    await this.upsert({ ...input, isActive: true, lastSeenAt: new Date() }, ['tenantId', 'token']);
    return (await this.findOne({ tenantId: input.tenantId, token: input.token }))!;
  }

  /** Active tokens of a user, newest first. */
  activeTokens(tenantId: string, userId: string): Promise<string[]> {
    return this.pluck('token', { tenantId, userId, isActive: true }, { order: { lastSeenAt: 'DESC' }, take: MAX_DEVICES_PER_USER });
  }

  /** Every device of a user (active or not), newest first. */
  findByUser(tenantId: string, userId: string): Promise<DeviceToken[]> {
    return this.findMany({ tenantId, userId }, { order: { lastSeenAt: 'DESC' } });
  }

  /** Tokens FCM reported as dead. */
  async deactivate(tenantId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.updateWhere({ tenantId, token: In(tokens) }, { isActive: false });
  }

  /** Deletes a token. Returns false if nothing was deleted. */
  async remove(tenantId: string, token: string): Promise<boolean> {
    return (await this.deleteWhere({ tenantId, token })) > 0;
  }
}
