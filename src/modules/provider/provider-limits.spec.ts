/**
 * Provider limits: validation ranges, pairing rules and update merging.
 */

import { mergeLimits, validateLimits } from './provider-limits.js';

describe('provider limits', () => {
  it('accepts a full set and an empty one', () => {
    expect(validateLimits({ rateMax: 20, rateDurationMs: 1000, maxConcurrency: 5, maxAttempts: 3, backoffMs: 2000 })).toEqual([]);
    expect(validateLimits({})).toEqual([]);
  });

  it.each([
    [{ rateMax: 20 }, 'set together'],
    [{ maxAttempts: 0 }, 'between 1 and 20'],
    [{ maxConcurrency: 1.5 }, 'integer'],
    [{ backoffMs: 50 }, 'between 100'],
    [{ burst: 3 } as never, 'not supported'],
  ])('rejects %j', (limits, message) => {
    expect(validateLimits(limits).join(' ')).toContain(message);
  });

  it('merges updates: given fields replace, 0 removes', () => {
    expect(mergeLimits({ rateMax: 20, rateDurationMs: 1000, maxAttempts: 3 }, { maxAttempts: 0, maxConcurrency: 4 })).toEqual({
      rateMax: 20,
      rateDurationMs: 1000,
      maxConcurrency: 4,
    });
  });
});
