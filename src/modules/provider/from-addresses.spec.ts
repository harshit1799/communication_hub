/**
 * From selection: default From per provider, From names (which also decide
 * the providers), literal addresses, and validation of from_addresses.
 */

import { NotificationChannel } from '../../constant/index.js';
import { selectFrom, validateFromAddresses } from './from-addresses.js';
import type { ProviderHandle } from './provider.types.js';

const E = NotificationChannel.Email;
const MAIL_FROM = 'Platform <no-reply@platform.io>';

const handle = (name: string, settings: Record<string, string>, fromAddresses: Record<string, string> = {}) =>
  ({ spec: { id: name, name, provider: 'smtp', settings, fromAddresses }, client: () => Promise.reject(new Error('unused')) }) as unknown as ProviderHandle;

// One SMTP account with three addresses, and an SES backup that only has billing@.
const smtp = handle('smtp-main', { from: 'Acme <no-reply@acme.com>' }, {
  support: 'Acme Support <support@acme.com>',
  billing: 'Acme Billing <billing@acme.com>',
  alerts: 'Acme Alerts <alerts@acme.com>',
});
const ses = handle('ses-backup', { from: 'Acme <no-reply@mail.acme.com>' }, { billing: 'Acme Billing <billing@mail.acme.com>' });
const both = [smtp, ses];

const pick = (requested?: string) => {
  const s = selectFrom(E, both, requested, MAIL_FROM);
  if (!s.ok) throw new Error(s.error);
  return s.handles.map((h) => [h.spec.name, s.fromFor(h)]);
};

describe('selectFrom', () => {
  it('no from: every provider with its default', () => {
    expect(pick()).toEqual([
      ['smtp-main', 'Acme <no-reply@acme.com>'],
      ['ses-backup', 'Acme <no-reply@mail.acme.com>'],
    ]);
  });

  it('a From name: only providers that have it, each with its own address', () => {
    expect(pick('support')).toEqual([['smtp-main', 'Acme Support <support@acme.com>']]);
    expect(pick('billing')).toEqual([
      ['smtp-main', 'Acme Billing <billing@acme.com>'],
      ['ses-backup', 'Acme Billing <billing@mail.acme.com>'],
    ]);
  });

  it('an address: providers that list it, or every provider', () => {
    expect(pick('Acme Alerts <alerts@acme.com>')).toEqual([['smtp-main', 'Acme Alerts <alerts@acme.com>']]);
    expect(pick('other@acme.com')).toEqual([
      ['smtp-main', 'other@acme.com'],
      ['ses-backup', 'other@acme.com'],
    ]);
  });

  it('rejects an unknown name; falls back to MAIL_FROM without a default', () => {
    expect(selectFrom(E, both, 'marketing', MAIL_FROM)).toMatchObject({ ok: false });
    const bare = selectFrom(E, [handle('plain', {})], undefined, MAIL_FROM);
    expect(bare.ok && bare.fromFor(bare.handles[0])).toBe(MAIL_FROM);
  });
});

describe('validateFromAddresses', () => {
  it('checks names and addresses per channel', () => {
    expect(validateFromAddresses(E, { billing: 'Acme <billing@acme.com>' })).toEqual([]);
    expect(validateFromAddresses(E, { Billing: 'x' }).join(' ')).toMatch(/lowercase.*not a valid email/);
    expect(validateFromAddresses(NotificationChannel.Sms, { india: 'ACMEIN', us: '+14155550100' })).toEqual([]);
    expect(validateFromAddresses(NotificationChannel.Push, { a: 'b' })[0]).toContain('only supported');
  });
});
