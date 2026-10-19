/**
 * Small, dependency-free helpers shared across modules.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_KEY_PREFIX } from '../constant/index.js';

/** New tenant API key: "chk_" + 256 random bits (base64url). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

/** Hex SHA-256. Keys are high-entropy random values, so no salt/KDF needed. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Displayable start of a key, e.g. "chk_a1b2c3d4". */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 8);
}

/** Constant-time string comparison (hashing first equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

/** Splits an array into chunks of at most `size` items. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** FCM data payloads only accept string values. */
export function stringifyValues(
  values: Record<string, unknown> | null | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
}

/** Error message from anything that was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
