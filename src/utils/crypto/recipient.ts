/**
 * Recipient normalisation for blind indexes and log masking. The same
 * address must always hash the same way: "Jane@Example.com " and
 * "jane@example.com" are one recipient.
 */

/** Canonical form of a recipient for hashing (emails are case-insensitive in practice). */
export function normaliseRecipient(channel: string, recipient: string): string {
  const value = recipient.trim();
  return channel === 'email' ? value.toLowerCase() : value;
}

/**
 * Log-safe form of a recipient: "j***@example.com", "+1415*****23",
 * "dGVz…" (tokens). Never log a raw recipient.
 */
export function maskRecipient(recipient: string): string {
  const at = recipient.indexOf('@');
  if (at > 0) return `${recipient[0]}***${recipient.slice(at)}`;
  if (recipient.startsWith('+')) return `${recipient.slice(0, 5)}${'*'.repeat(Math.max(recipient.length - 7, 0))}${recipient.slice(-2)}`;
  return `${recipient.slice(0, 4)}…`;
}
