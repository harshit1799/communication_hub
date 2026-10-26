/**
 * Application-level encryption for sensitive columns (recipients, template
 * data, provider credentials).
 *
 *   ciphertext = "enc:v1:<keyId>:" + base64url(iv(12) | tag(16) | data)
 *
 * AES-256-GCM (authenticated: tampering fails decryption). Every value is
 * bound to its column through the GCM additional data ("notifications.recipient",
 * ...), so a ciphertext copied into another column does not decrypt.
 *
 * Key rotation: ENCRYPTION_KEYS holds every key ever used ("k1:<b64>,k2:<b64>");
 * new values are written with ENCRYPTION_ACTIVE_KEY, old ones still decrypt
 * by the key id they carry. Re-encrypt old rows in the background, then
 * drop the old key.
 *
 * Encrypted columns can't be searched, so lookups use a blind index: an
 * HMAC-SHA256 of the normalised value under a separate key (BLIND_INDEX_KEY),
 * scoped by tenant so equal values don't correlate across tenants.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Keys as configured: key id -> 32-byte key. */
export interface CipherKeys {
  keys: Map<string, Buffer>;
  activeKeyId: string;
  blindIndexKey: Buffer;
}

/**
 * Parses ENCRYPTION_KEYS ("id:base64,id2:base64"), ENCRYPTION_ACTIVE_KEY and
 * BLIND_INDEX_KEY. Throws a readable error for anything malformed.
 */
export function parseCipherKeys(raw: { keys?: string; activeKeyId?: string; blindIndexKey?: string }): CipherKeys {
  const errors: string[] = [];
  const keys = new Map<string, Buffer>();
  for (const entry of (raw.keys ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const [id, b64] = entry.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!id || !/^[\w-]{1,32}$/.test(id)) errors.push(`ENCRYPTION_KEYS: invalid key id "${id}"`);
    else if (key.length !== KEY_BYTES) errors.push(`ENCRYPTION_KEYS: key "${id}" must be ${KEY_BYTES} bytes (base64)`);
    else keys.set(id, key);
  }
  if (keys.size === 0) errors.push('ENCRYPTION_KEYS must contain at least one key, e.g. k1:$(openssl rand -base64 32)');
  const activeKeyId = raw.activeKeyId || [...keys.keys()].at(-1) || '';
  if (keys.size > 0 && !keys.has(activeKeyId)) errors.push(`ENCRYPTION_ACTIVE_KEY "${activeKeyId}" is not in ENCRYPTION_KEYS`);
  const blindIndexKey = Buffer.from(raw.blindIndexKey ?? '', 'base64');
  if (blindIndexKey.length < KEY_BYTES) errors.push(`BLIND_INDEX_KEY must be at least ${KEY_BYTES} bytes (base64)`);
  if (errors.length) throw new Error(errors.join('\n- '));
  return { keys, activeKeyId, blindIndexKey };
}

/** Encrypts/decrypts strings and computes blind indexes. Stateless per call. */
export class FieldCipher {
  /**
   * The process-wide instance used by the TypeORM column transformer
   * (transformers are created at decoration time, before DI exists).
   * Set once at startup by CryptoModule / the migration data source.
   */
  private static instance?: FieldCipher;

  constructor(private readonly config: CipherKeys) {}

  static configure(cipher: FieldCipher): void {
    FieldCipher.instance = cipher;
  }

  static get(): FieldCipher {
    if (!FieldCipher.instance) throw new Error('FieldCipher used before it was configured (CryptoModule)');
    return FieldCipher.instance;
  }

  /** Whether a stored value is ciphertext (vs. legacy plaintext). */
  static isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  /** Encrypts with the active key; `context` names the column (GCM AAD). */
  encrypt(plaintext: string, context: string): string {
    const keyId = this.config.activeKeyId;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.config.keys.get(keyId)!, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${PREFIX}${keyId}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
  }

  /** Decrypts a value written by encrypt() with the same context. */
  decrypt(ciphertext: string, context: string): string {
    if (!FieldCipher.isEncrypted(ciphertext)) throw new Error(`${context}: value is not encrypted`);
    const rest = ciphertext.slice(PREFIX.length);
    const separator = rest.indexOf(':');
    const keyId = rest.slice(0, separator);
    const key = this.config.keys.get(keyId);
    if (!key) throw new Error(`${context}: unknown encryption key "${keyId}" (missing from ENCRYPTION_KEYS?)`);
    const raw = Buffer.from(rest.slice(separator + 1), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  /**
   * Deterministic keyed hash for equality lookups on encrypted values.
   * `scope` (the tenant id) keeps equal values of different tenants apart.
   */
  blindIndex(scope: string, value: string): string {
    return createHmac('sha256', this.config.blindIndexKey).update(`${scope}\u0000${value}`).digest('hex');
  }
}
