/**
 * Data access for the `notification_attempts` audit table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAttempt } from '../../models/index.js';

/** Append-only writes; reads happen through the notification relation. */
@Injectable()
export class NotificationAttemptRepository {
  constructor(
    @InjectRepository(NotificationAttempt) private readonly attempts: Repository<NotificationAttempt>,
  ) {}

  /** Stores one attempt. */
  async record(input: {
    notificationId: string;
    attempt: number;
    provider: string;
    success: boolean;
    providerMessageId?: string | null;
    error?: string | null;
    permanent?: boolean;
    durationMs: number;
  }): Promise<void> {
    await this.attempts.insert({
      ...input,
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
      permanent: input.permanent ?? false,
    });
  }
}
