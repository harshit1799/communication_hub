/**
 * Bulk fan-out of recipients / userIds into one notification per target.
 */

import { createHash } from 'node:crypto';
import { LIMITS } from '../../constant/index.js';
import { normaliseRecipient } from '../../utils/crypto/recipient.js';
import { BulkItem, countTargets, expandBulkItem, LIST_KEY_MAX } from './bulk-targets.js';

// Stand-in for the service's keyed blind index: deterministic per normalised target.
const hash = (channel: string, target: string) => createHash('sha256').update(normaliseRecipient(channel, target)).digest('hex');

/** The expanded items, failing the test on an error result. */
function expand<T extends BulkItem>(item: T) {
  const result = expandBulkItem(item, hash);
  if (!result.ok) throw new Error(result.error);
  return result.items;
}

describe('expandBulkItem', () => {
  it('leaves a single-target item unchanged', () => {
    const item = { channel: 'sms', recipient: '+14155550100', body: 'b', idempotencyKey: 'k' };
    expect(expand(item)).toEqual([item]);
  });

  it('splits a comma-separated recipient and merges recipients, dropping duplicates', () => {
    const out = expand({
      channel: 'email',
      recipient: 'a@x.com, B@x.com',
      recipients: ['b@x.com', 'c@x.com', ' '],
      template: 'order-shipped',
    });
    expect(out).toEqual([
      { channel: 'email', recipient: 'a@x.com', template: 'order-shipped' },
      { channel: 'email', recipient: 'B@x.com', template: 'order-shipped' },
      { channel: 'email', recipient: 'c@x.com', template: 'order-shipped' },
    ]);
  });

  it('does not split a push recipient on commas', () => {
    const item = { channel: 'push', recipient: 'tok,en', body: 'b' };
    expect(expand(item)).toEqual([item]);
    expect(countTargets(item)).toBe(1);
  });

  it('fans out userIds for push and in-app', () => {
    const out = expand({ channel: 'push', userIds: ['u-1', 'u-2'], body: 'hi' });
    expect(out).toEqual([
      { channel: 'push', userId: 'u-1', body: 'hi' },
      { channel: 'push', userId: 'u-2', body: 'hi' },
    ]);
    expect(expand({ channel: 'in_app', userIds: ['u-1'], body: 'hi' })).toEqual([{ channel: 'in_app', userId: 'u-1', body: 'hi' }]);
  });

  it('gives each target its own stable idempotency key from the supplied hash', () => {
    const keys = (recipients: string[]) => expand({ channel: 'sms', recipients, idempotencyKey: 'otp-1' }).map((n) => n.idempotencyKey);
    const [a, b] = keys(['+14155550100', '+14155550101']);
    expect(a).toBe(`otp-1:${hash('sms', '+14155550100').slice(0, 16)}`);
    expect(a).not.toBe(b);
    // Order of the list doesn't change a target's key.
    expect(keys(['+14155550101', '+14155550100'])).toEqual([b, a]);
  });

  it('keeps the key of a target when the list grows (list form always derives keys)', () => {
    const keyOf = (item: object) => expand({ channel: 'sms', body: 'b', idempotencyKey: 'K', ...item })[0].idempotencyKey;
    const one = keyOf({ recipients: ['+14155550100'] });
    expect(one).toMatch(/^K:[0-9a-f]{16}$/);
    expect(keyOf({ recipients: ['+14155550100', '+14155550101'] })).toBe(one);
    expect(keyOf({ recipient: '+14155550100, +14155550101' })).toBe(one);
    // A plain single recipient keeps the key as sent (single-send compatible).
    expect(keyOf({ recipient: '+14155550100' })).toBe('K');
  });

  it('limits the key of a list-form item so the suffixed key fits', () => {
    const item = (length: number) => ({ channel: 'sms', recipients: ['+14155550100'], body: 'b', idempotencyKey: 'k'.repeat(length) });
    expect(LIST_KEY_MAX).toBe(LIMITS.IDEMPOTENCY_KEY_MAX - 17);
    expect(expand(item(LIST_KEY_MAX))[0].idempotencyKey).toHaveLength(LIMITS.IDEMPOTENCY_KEY_MAX);
    expect(expandBulkItem(item(LIST_KEY_MAX + 1), hash)).toEqual({ ok: false, error: expect.stringContaining(`at most ${LIST_KEY_MAX} characters`) });
    // A plain item keeps the single-send limit (checked by the DTO).
    expect(expand({ channel: 'sms', recipient: '+14155550100', idempotencyKey: 'k'.repeat(LIMITS.IDEMPOTENCY_KEY_MAX) })).toHaveLength(1);
  });

  it('reports a list that is empty after trimming as a missing recipient', () => {
    expect(expand({ channel: 'sms', recipient: ' , ', body: 'b' })).toEqual([{ channel: 'sms', recipient: undefined, userId: undefined, body: 'b' }]);
  });

  it('counts an upper bound of targets without expanding', () => {
    expect(countTargets({ channel: 'sms' })).toBe(1);
    expect(countTargets({ channel: 'sms', recipient: '+1' })).toBe(1);
    expect(countTargets({ channel: 'email', recipient: 'a@x.com, b@x.com', recipients: ['c@x.com'] })).toBe(3);
    expect(countTargets({ channel: 'push', userId: 'u-0', userIds: ['u-1', 'u-2'] })).toBe(3);
  });

  it('rejects several recipients and several userIds together', () => {
    expect(expandBulkItem({ channel: 'push', recipients: ['t1', 't2'], userIds: ['u1', 'u2'] }, hash)).toEqual({
      ok: false,
      error: 'set several recipients or several userIds, not both',
    });
  });
});
