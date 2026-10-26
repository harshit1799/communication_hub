/**
 * TypeORM column transformers that encrypt on write and decrypt on read, so
 * repositories and services work with plaintext and can't forget to encrypt:
 *
 *   @Column({ type: 'text', nullable: true, transformer: encryptedString('notifications.recipient') })
 *   recipient: string | null;
 *
 * Never filter on an encrypted column (ciphertexts are randomised); store a
 * blind index next to it and query that instead.
 */

import { ValueTransformer } from 'typeorm';
import { FieldCipher } from './field-cipher.js';

/** Encrypted string column. `context` is "<table>.<column>" (bound into the ciphertext). */
export function encryptedString(context: string): ValueTransformer {
  return {
    to: (value: string | null | undefined) => (value == null ? value : FieldCipher.get().encrypt(value, context)),
    from: (value: string | null) => (value == null ? value : FieldCipher.get().decrypt(value, context)),
  };
}

/** Encrypted JSON column (stored as text). */
export function encryptedJson(context: string): ValueTransformer {
  return {
    to: (value: unknown) => (value == null ? value : FieldCipher.get().encrypt(JSON.stringify(value), context)),
    from: (value: string | null) => (value == null ? value : JSON.parse(FieldCipher.get().decrypt(value, context))),
  };
}

/** Column contexts, one per encrypted column. */
export const ENCRYPTED = {
  NOTIFICATION_RECIPIENT: 'notifications.recipient',
  NOTIFICATION_DATA: 'notifications.data',
  PROVIDER_CREDENTIALS: 'provider_configs.credentials',
} as const;
