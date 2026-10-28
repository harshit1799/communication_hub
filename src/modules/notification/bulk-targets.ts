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

/** Commas in a string, without allocating the split. */
function countCommas(value: string): number {
  let count = 0;
  for (let i = value.indexOf(','); i !== -1; i = value.indexOf(',', i + 1)) count++;
  return count;
}

/**
 * Upper bound of the notifications one item expands to (before duplicates
 * are dropped). Cheap, so oversized requests are rejected before anything
 * is allocated per target.
 */
export function countTargets(item: BulkItem): number {
  const fromRecipient = item.recipient ? countCommas(item.recipient) + 1 : 0;
  const fromUser = item.userId ? 1 : 0;
  return Math.max(1, fromRecipient + (item.recipients?.length ?? 0), fromUser + (item.userIds?.length ?? 0));
}

/**
 * One item -> one item per target. A plain item (single recipient / userId,
 * no list) comes back unchanged with its idempotency key. An item in the
 * list form (recipients, userIds or a comma-separated recipient) always
 * gets per-target keys, even with one target, so growing the list on a
 * retry never re-sends to the earlier targets. Returns an error message
 * when the item lists several recipients and several userIds at once.
 */
export function expandBulkItem<T extends BulkItem>(item: T): Omit<T, 'recipients' | 'userIds'>[] | string {
  const { recipients = [], userIds = [], ...base } = item;
  const listForm = recipients.length > 0 || userIds.length > 0 || Boolean(base.recipient?.includes(','));
  if (!listForm) return [base];

  const channel = base.channel ?? '';
  const toRecipients = unique(channel, [...(base.recipient?.split(',') ?? []), ...recipients]);
  const toUsers = unique(channel, [...(base.userId ? [base.userId] : []), ...userIds]);
  if (toRecipients.length > 1 && toUsers.length > 1) return 'set several recipients or several userIds, not both';

  // A field with one value stays on every item; the DTO reports a missing target.
  const single = { recipient: toRecipients.length === 1 ? toRecipients[0] : undefined, userId: toUsers.length === 1 ? toUsers[0] : undefined };
  const [field, targets] =
    toUsers.length > 1 || (toRecipients.length === 0 && toUsers.length > 0) ? (['userId', toUsers] as const) : (['recipient', toRecipients] as const);
  if (targets.length === 0) return [{ ...base, ...single }];
  return targets.map((target) => ({
    ...base,
    ...single,
    [field]: target,
    ...(base.idempotencyKey ? { idempotencyKey: keyFor(base.idempotencyKey, channel, target) } : {}),
  }));
}
