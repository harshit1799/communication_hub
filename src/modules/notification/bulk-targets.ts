/**
 * Bulk fan-out: one SendBulkNotifications item can name several targets for
 * the same content (recipients, user_ids, or, for email and SMS, a
 * comma-separated recipient). Each target becomes its own notification, so
 * delivery, status, retry and idempotency stay per recipient.
 *
 *   { channel: email, recipient: "a@x.com, b@x.com", template, ... }
 *   { channel: sms,   recipients: ["+14155550100", "+14155550101"], ... }
 *   { channel: push,  userIds: ["u-1", "u-2"], ... }
 *
 * The idempotency key gets a per-target suffix. The caller supplies the
 * hash (NotificationService uses the keyed per-tenant blind index), so the
 * key reveals no more about the recipient than recipient_hash already does,
 * and the order of the list doesn't matter.
 */

import { LIMITS, NotificationChannel } from '../../constant/index.js';
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

/** Hex characters of the target hash appended to the idempotency key. */
const KEY_SUFFIX_HEX = 16;

/** Longest idempotency key an item in the list form may carry (":" plus the suffix). */
export const LIST_KEY_MAX = LIMITS.IDEMPOTENCY_KEY_MAX - 1 - KEY_SUFFIX_HEX;

/** Channels whose recipient may be a comma-separated list (push tokens never are). */
const COMMA_LIST_CHANNELS = new Set<string>([NotificationChannel.Email, NotificationChannel.Sms]);

/** Hash of one target, at least KEY_SUFFIX_HEX hex characters; must not depend on list order. */
export type TargetHash = (channel: string, target: string) => string;

/** expandBulkItem's outcome: the items to validate, or why the item is invalid. */
export type ExpandResult<T> = { ok: true; items: Omit<T, 'recipients' | 'userIds'>[] } | { ok: false; error: string };

/** Whether `recipient` is a comma-separated list on this channel. */
const isCommaList = (channel: string | undefined, recipient: string | undefined) =>
  COMMA_LIST_CHANNELS.has(channel ?? '') && Boolean(recipient?.includes(','));

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
  const fromRecipient = item.recipient ? (isCommaList(item.channel, item.recipient) ? countCommas(item.recipient) : 0) + 1 : 0;
  const fromUser = item.userId ? 1 : 0;
  return Math.max(1, fromRecipient + (item.recipients?.length ?? 0), fromUser + (item.userIds?.length ?? 0));
}

/**
 * One item -> one item per target. A plain item (single recipient / userId,
 * no list) comes back unchanged with its idempotency key. An item in the
 * list form (recipients, userIds or a comma-separated recipient) always
 * gets per-target keys "<key>:<hash>", even with one target, so growing the
 * list on a retry never re-sends to the earlier targets. Fails when the
 * item lists several recipients and several userIds at once, or when its
 * key leaves no room for the suffix.
 */
export function expandBulkItem<T extends BulkItem>(item: T, hashTarget: TargetHash): ExpandResult<T> {
  const { recipients = [], userIds = [], ...base } = item;
  const commaList = isCommaList(base.channel, base.recipient);
  const listForm = recipients.length > 0 || userIds.length > 0 || commaList;
  if (!listForm) return { ok: true, items: [base] };
  if (base.idempotencyKey && base.idempotencyKey.length > LIST_KEY_MAX) {
    return { ok: false, error: `idempotencyKey must be at most ${LIST_KEY_MAX} characters when an item lists targets (a per-target suffix is added)` };
  }

  const channel = base.channel ?? '';
  const fromRecipient = base.recipient ? (commaList ? base.recipient.split(',') : [base.recipient]) : [];
  const toRecipients = unique(channel, [...fromRecipient, ...recipients]);
  const toUsers = unique(channel, [...(base.userId ? [base.userId] : []), ...userIds]);
  if (toRecipients.length > 1 && toUsers.length > 1) return { ok: false, error: 'set several recipients or several userIds, not both' };

  // A field with one value stays on every item; the DTO reports a missing target.
  const single = { recipient: toRecipients.length === 1 ? toRecipients[0] : undefined, userId: toUsers.length === 1 ? toUsers[0] : undefined };
  const [field, targets] =
    toUsers.length > 1 || (toRecipients.length === 0 && toUsers.length > 0) ? (['userId', toUsers] as const) : (['recipient', toRecipients] as const);
  if (targets.length === 0) return { ok: true, items: [{ ...base, ...single }] };
  return {
    ok: true,
    items: targets.map((target) => ({
      ...base,
      ...single,
      [field]: target,
      ...(base.idempotencyKey ? { idempotencyKey: `${base.idempotencyKey}:${hashTarget(channel, target).slice(0, KEY_SUFFIX_HEX)}` } : {}),
    })),
  };
}
