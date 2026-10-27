/**
 * Data access for the `notification_attempts` audit table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { NotificationAttempt } from '../../models/index.js';

/** Append-only writes; reads happen through the notification relation. */
@Injectable()
export class NotificationAttemptRepository extends BaseRepository<NotificationAttempt> {
  constructor(@InjectRepository(NotificationAttempt) repository: Repository<NotificationAttempt>) {
    super(repository);
  }

  /** Stores one attempt (append-only, not read back). */
  async record(input: {
    notificationId: string;
    attempt: number;
    provider: string;
    providerName?: string | null;
    providerConfigId?: string | null;
    sender?: string | null;
    success: boolean;
    providerMessageId?: string | null;
    error?: string | null;
    permanent?: boolean;
    durationMs: number;
  }): Promise<void> {
    await this.insert({
      ...input,
      sender: input.sender ?? null,
      providerName: input.providerName ?? null,
      providerConfigId: input.providerConfigId ?? null,
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
      permanent: input.permanent ?? false,
    });
  }
}
