/**
 * Bulk fan-out of recipients / userIds into one notification per target.
 */

import { countTargets, expandBulkItem } from './bulk-targets.js';

describe('expandBulkItem', () => {
  it('leaves a single-target item unchanged', () => {
    const item = { channel: 'sms', recipient: '+14155550100', body: 'b', idempotencyKey: 'k' };
    expect(expandBulkItem(item)).toEqual([item]);
  });

  it('splits a comma-separated recipient and merges recipients, dropping duplicates', () => {
    const out = expandBulkItem({
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

  it('fans out userIds for push and in-app', () => {
    const out = expandBulkItem({ channel: 'push', userIds: ['u-1', 'u-2'], body: 'hi' });
    expect(out).toEqual([
      { channel: 'push', userId: 'u-1', body: 'hi' },
      { channel: 'push', userId: 'u-2', body: 'hi' },
    ]);
    expect(expandBulkItem({ channel: 'in_app', userIds: ['u-1'], body: 'hi' })).toEqual([{ channel: 'in_app', userId: 'u-1', body: 'hi' }]);
  });

  it('gives each target its own stable idempotency key', () => {
    const keys = (recipients: string[]) =>
      (expandBulkItem({ channel: 'sms', recipients, idempotencyKey: 'otp-1' }) as { idempotencyKey: string }[]).map((n) => n.idempotencyKey);
    const [a, b] = keys(['+14155550100', '+14155550101']);
    expect(a).toMatch(/^otp-1:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // Order of the list doesn't change a target's key.
    expect(keys(['+14155550101', '+14155550100'])).toEqual([b, a]);
  });

  it('keeps the key of a target when the list grows (list form always derives keys)', () => {
    const keyOf = (item: object) => (expandBulkItem({ channel: 'sms', body: 'b', idempotencyKey: 'K', ...item }) as { idempotencyKey: string }[])[0].idempotencyKey;
    const one = keyOf({ recipients: ['+14155550100'] });
    expect(one).toMatch(/^K:[0-9a-f]{16}$/);
    expect(keyOf({ recipients: ['+14155550100', '+14155550101'] })).toBe(one);
    expect(keyOf({ recipient: '+14155550100, +14155550101' })).toBe(one);
    // A plain single recipient keeps the key as sent (single-send compatible).
    expect(keyOf({ recipient: '+14155550100' })).toBe('K');
  });

  it('reports a list that is empty after trimming as a missing recipient', () => {
    expect(expandBulkItem({ channel: 'sms', recipient: ' , ', body: 'b' })).toEqual([{ channel: 'sms', recipient: undefined, userId: undefined, body: 'b' }]);
  });

  it('counts an upper bound of targets without expanding', () => {
    expect(countTargets({ channel: 'sms' })).toBe(1);
    expect(countTargets({ channel: 'sms', recipient: '+1' })).toBe(1);
    expect(countTargets({ channel: 'email', recipient: 'a@x.com, b@x.com', recipients: ['c@x.com'] })).toBe(3);
    expect(countTargets({ channel: 'push', userId: 'u-0', userIds: ['u-1', 'u-2'] })).toBe(3);
  });

  it('rejects several recipients and several userIds together', () => {
    expect(expandBulkItem({ channel: 'push', recipients: ['t1', 't2'], userIds: ['u1', 'u2'] })).toBe(
      'set several recipients or several userIds, not both',
    );
  });
});
