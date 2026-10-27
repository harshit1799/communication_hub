/**
 * From address selection, shared by the API (accept-time check) and the
 * worker (delivery), so both always agree.
 *
 * A provider has a default "From" (settings.from) and optional named ones
 * (from_addresses: { support: "...", billing: "..." }). The send's `from`:
 *
 *   unset         every provider, each with its settings.from
 *                 (email without one: MAIL_FROM; SMS: the vendor's default)
 *   a name        only the providers that have that name, each sending as its
 *                 own address for it ("billing" can be billing@ on SMTP and on SES)
 *   an address    sent as is; providers listing that address are preferred
 *                 (only them if any do), otherwise every provider
 *   neither       rejected: not a configured name and not a valid address
 */

import { NotificationChannel } from '../../constant/index.js';
import { isFromValue } from '../../validator/from.validator.js';
import type { ProviderHandle, ProviderSpec } from './provider.types.js';

/** From names: what clients send as `from`, e.g. "billing", "no-reply". */
export const FROM_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const MAX_FROM_ADDRESSES = 20;

/** Problems with a provider's from_addresses (empty = valid). */
export function validateFromAddresses(channel: NotificationChannel, fromAddresses: Record<string, string>): string[] {
  const errors: string[] = [];
  const entries = Object.entries(fromAddresses);
  if (entries.length > 0 && channel !== NotificationChannel.Email && channel !== NotificationChannel.Sms) {
    return ['from_addresses are only supported for CHANNEL_EMAIL and CHANNEL_SMS providers'];
  }
  if (entries.length > MAX_FROM_ADDRESSES) errors.push(`at most ${MAX_FROM_ADDRESSES} from_addresses per provider`);
  for (const [name, address] of entries) {
    if (!FROM_NAME_REGEX.test(name)) errors.push(`from_addresses name "${name}" must be 1-50 lowercase letters, digits or dashes`);
    if (!isFromValue(channel, address)) errors.push(`from_addresses.${name} is not a valid ${channel === NotificationChannel.Sms ? 'SMS sender' : 'email address'}`);
  }
  return errors;
}

/** Every From of a provider: the default first, then the names alphabetically (jsonb has no key order). */
export function addressesOf(spec: Pick<ProviderSpec, 'settings' | 'fromAddresses'>): { name: string | null; address: string; isDefault: boolean }[] {
  const list = spec.settings.from ? [{ name: null, address: spec.settings.from, isDefault: true }] : [];
  const named = Object.entries(spec.fromAddresses ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return [...list, ...named.map(([name, address]) => ({ name, address, isDefault: false }))];
}

export type FromSelection =
  | { ok: true; handles: ProviderHandle[]; fromFor: (handle: ProviderHandle) => string | null }
  | { ok: false; error: string };

/** The providers to use, in failover order, and the From each sends as. */
export function selectFrom(
  channel: NotificationChannel,
  handles: ProviderHandle[],
  requested: string | null | undefined,
  mailFrom: string,
): FromSelection {
  const hasFrom = channel === NotificationChannel.Email || channel === NotificationChannel.Sms;
  if (!hasFrom) return { ok: true, handles, fromFor: () => null };

  if (!requested) {
    return {
      ok: true,
      handles,
      fromFor: (h) => h.spec.settings.from ?? (channel === NotificationChannel.Email ? mailFrom : null),
    };
  }

  const named = handles.filter((h) => h.spec.fromAddresses?.[requested] !== undefined);
  if (named.length > 0) return { ok: true, handles: named, fromFor: (h) => h.spec.fromAddresses[requested] };

  if (isFromValue(channel, requested)) {
    const listing = handles.filter((h) => addressesOf(h.spec).some((a) => a.address === requested));
    return { ok: true, handles: listing.length > 0 ? listing : handles, fromFor: () => requested };
  }

  return { ok: false, error: `from "${requested}" is not one of the tenant's From names (GET /v1/from-addresses) and not a valid address` };
}
