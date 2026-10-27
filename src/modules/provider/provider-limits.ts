/**
 * Per-provider delivery limits (provider_configs.limits), replacing the
 * platform env defaults for messages a provider delivers:
 *
 *   maxAttempts, backoffMs     retry policy, set on the job when it is queued
 *                              (from the first provider that will deliver it)
 *   rateMax / rateDurationMs   at most rateMax sends per window, across all workers
 *   maxConcurrency             at most this many sends in flight at once
 *
 * The rate and concurrency caps are enforced by ProviderThrottle in Redis.
 */

export interface ProviderLimits {
  rateMax?: number;
  rateDurationMs?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

const RANGES: Record<keyof ProviderLimits, [number, number]> = {
  rateMax: [1, 100_000],
  rateDurationMs: [100, 3_600_000],
  maxConcurrency: [1, 1_000],
  maxAttempts: [1, 20],
  backoffMs: [100, 3_600_000],
};

/** Applies an update: given fields replace the stored ones, 0 removes a limit. */
export function mergeLimits(current: ProviderLimits, update: ProviderLimits | undefined): ProviderLimits {
  const merged: ProviderLimits = { ...current };
  for (const [key, value] of Object.entries(update ?? {}) as [keyof ProviderLimits, number | undefined][]) {
    if (value === undefined) continue;
    if (value === 0) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Problems with a provider's limits (empty = valid). */
export function validateLimits(limits: ProviderLimits): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(limits) as [keyof ProviderLimits, number][]) {
    const range = RANGES[key];
    if (!range) {
      errors.push(`limits.${key} is not supported`);
      continue;
    }
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      errors.push(`limits.${key} must be an integer between ${range[0]} and ${range[1]}`);
    }
  }
  if ((limits.rateMax === undefined) !== (limits.rateDurationMs === undefined)) {
    errors.push('limits.rateMax and limits.rateDurationMs must be set together');
  }
  return errors;
}
