/**
 * Bulk fan-out: one SendBulkNotifications item can name several targets for
 * the same content (recipients, user_ids, or a comma-separated recipient).
 * Each target becomes its own notification, so delivery, status, retry and
 * idempotency stay per recipient.
 *
 *   { channel: email, recipient: "a@x.com, b@x.com", template, ... }
 *   { channel: sms,   recipients: ["+14155550100", "+14155550101"], ... }
 *   { channel: push,  userIds: ["u-1", "u-2"], ... }
 *
 * The idempotency key gets a per-target suffix (a hash, so no recipient
 * ends up in plain text and the order of the list doesn't matter).
 */

import { createHash } from 'node:crypto';
import { normaliseRecipient } from '../../utils/crypto/recipient.js';

/** The decoded fields fan-out looks at; everything else is copied as is. */
export interface BulkItem {
  channel?: string;
  recipient?: string;
  recipients?: string[];
  userId?: string;
  userIds?: string[];
  idempotencyKey?: string;
}

/** Trimmed, non-empty, unique (by normalised form) values in request order. */
function unique(channel: string, values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((v) => v.trim())
    .filter((v) => {
      const key = normaliseRecipient(channel, v);
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Stable per-target idempotency key: "<key>:<16 hex chars>". */
const keyFor = (key: string, channel: string, target: string) =>
  `${key}:${createHash('sha256').update(normaliseRecipient(channel, target)).digest('hex').slice(0, 16)}`;

/**
 * One item -> one item per target. Items with a single target come back
 * unchanged (same idempotency key). Returns an error message when the item
 * lists several recipients and several userIds at once.
 */
export function expandBulkItem<T extends BulkItem>(item: T): Omit<T, 'recipients' | 'userIds'>[] | string {
  const { recipients = [], userIds = [], ...base } = item;
  const channel = base.channel ?? '';
  const toRecipients = unique(channel, [...(base.recipient?.split(',') ?? []), ...recipients]);
  const toUsers = unique(channel, [...(base.userId ? [base.userId] : []), ...userIds]);

  if (toRecipients.length > 1 && toUsers.length > 1) return 'set several recipients or several userIds, not both';
  const [field, targets] = toUsers.length > 1 ? (['userId', toUsers] as const) : (['recipient', toRecipients] as const);
  if (targets.length <= 1) {
    // A single target (from either field); the DTO reports a missing one.
    return [
      {
        ...base,
        ...(toRecipients.length === 1 ? { recipient: toRecipients[0] } : {}),
        ...(toUsers.length === 1 ? { userId: toUsers[0] } : {}),
      },
    ];
  }
  return targets.map((target) => ({
    ...base,
    [field]: target,
    ...(base.idempotencyKey ? { idempotencyKey: keyFor(base.idempotencyKey, channel, target) } : {}),
  }));
}
