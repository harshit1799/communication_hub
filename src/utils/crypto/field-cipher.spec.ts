/**
 * FieldCipher: round trips, tamper detection, column binding, key rotation
 * and blind indexes.
 */

import { randomBytes } from 'node:crypto';
import { FieldCipher, parseCipherKeys } from './field-cipher.js';

const key = () => randomBytes(32).toString('base64');
const k1 = key();
const k2 = key();
const blind = key();

const cipher = (keys: string, active?: string) =>
  new FieldCipher(parseCipherKeys({ keys, activeKeyId: active, blindIndexKey: blind }));

describe('FieldCipher', () => {
  const c = cipher(`k1:${k1}`);

  it('round-trips and randomises ciphertexts', () => {
    const a = c.encrypt('jane@example.com', 'notifications.recipient');
    const b = c.encrypt('jane@example.com', 'notifications.recipient');
    expect(a).not.toBe(b);
    expect(a.startsWith('enc:v1:k1:')).toBe(true);
    expect(c.decrypt(a, 'notifications.recipient')).toBe('jane@example.com');
  });

  it('rejects tampered ciphertexts', () => {
    const value = c.encrypt('+14155550123', 'notifications.recipient');
    const tampered = value.slice(0, -2) + (value.endsWith('A') ? 'BB' : 'AA');
    expect(() => c.decrypt(tampered, 'notifications.recipient')).toThrow();
  });

  it('binds ciphertexts to their column', () => {
    const value = c.encrypt('secret', 'provider_configs.credentials');
    expect(() => c.decrypt(value, 'notifications.recipient')).toThrow();
  });

  it('decrypts old values after a key rotation', () => {
    const old = c.encrypt('legacy', 'ctx');
    const rotated = cipher(`k1:${k1},k2:${k2}`, 'k2');
    expect(rotated.encrypt('new', 'ctx').startsWith('enc:v1:k2:')).toBe(true);
    expect(rotated.decrypt(old, 'ctx')).toBe('legacy');
  });

  it('blind index is deterministic and scoped', () => {
    expect(c.blindIndex('t-1', 'a@b.com')).toBe(c.blindIndex('t-1', 'a@b.com'));
    expect(c.blindIndex('t-1', 'a@b.com')).not.toBe(c.blindIndex('t-2', 'a@b.com'));
  });

  it.each([
    [{ keys: '', blindIndexKey: blind }, 'at least one key'],
    [{ keys: `k1:${randomBytes(16).toString('base64')}`, blindIndexKey: blind }, 'must be 32 bytes'],
    [{ keys: `k1:${k1}`, activeKeyId: 'k9', blindIndexKey: blind }, 'not in ENCRYPTION_KEYS'],
    [{ keys: `k1:${k1}`, blindIndexKey: '' }, 'BLIND_INDEX_KEY'],
  ])('validates configuration %#', (raw, message) => {
    expect(() => parseCipherKeys(raw)).toThrow(message);
  });
});
