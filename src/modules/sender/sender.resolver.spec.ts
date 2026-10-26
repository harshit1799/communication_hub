/**
 * Sender selection: explicit request, rule order (template-specific before
 * general, then priority), matchers, inactive senders and the default.
 */

import { SenderRuleMatch } from '../../constant/index.js';
import { PermanentDeliveryError } from '../../utils/channel/channel.types.js';
import type { SenderSnapshot } from './sender.repository.js';
import { ruleMatches, selectSender } from './sender.resolver.js';

const sender = (id: string, extra: Partial<SenderSnapshot['senders'][number]> = {}) => ({
  id,
  value: `${id}@acme.test`,
  providerConfigId: null,
  isDefault: false,
  isActive: true,
  ...extra,
});

const rule = (senderId: string, matchType: SenderRuleMatch, matchValue: string | null, extra: Partial<SenderSnapshot['rules'][number]> = {}) => ({
  id: `r-${senderId}-${matchValue}`,
  templateId: null,
  matchType,
  matchValue,
  senderId,
  priority: 100,
  ...extra,
});

describe('ruleMatches', () => {
  it.each([
    [SenderRuleMatch.Any, null, 'anything', true],
    [SenderRuleMatch.RecipientPrefix, '+91', '+919876543210', true],
    [SenderRuleMatch.RecipientPrefix, '+91', '+14155550123', false],
    [SenderRuleMatch.RecipientDomain, 'gmail.com', 'Jane@GMAIL.com', true],
    [SenderRuleMatch.RecipientDomain, 'gmail.com', 'jane@notgmail.com', false],
    [SenderRuleMatch.RecipientDomain, 'gmail.com', null, false],
  ])('%s %s vs %s -> %s', (matchType, matchValue, recipient, expected) => {
    expect(ruleMatches({ matchType, matchValue }, recipient)).toBe(expected);
  });
});

describe('selectSender', () => {
  const snapshot: SenderSnapshot = {
    senders: [sender('default', { isDefault: true }), sender('india'), sender('invoice'), sender('retired', { isActive: false })],
    rules: [
      // Sorted by priority, as the repository returns them.
      rule('retired', SenderRuleMatch.Any, null, { priority: 1 }),
      rule('india', SenderRuleMatch.RecipientPrefix, '+91', { priority: 10 }),
      rule('invoice', SenderRuleMatch.Any, null, { templateId: 'tpl-invoice', priority: 50 }),
    ],
  };

  it('uses the requested sender', () => {
    expect(selectSender(snapshot, { senderId: 'india', recipient: '+1415' })).toMatchObject({ senderId: 'india', source: 'request' });
  });

  it('never silently replaces an inactive requested sender', () => {
    expect(() => selectSender(snapshot, { senderId: 'retired' })).toThrow(PermanentDeliveryError);
  });

  it('prefers template-specific rules over general ones, skipping rules to inactive senders', () => {
    expect(selectSender(snapshot, { templateId: 'tpl-invoice', recipient: '+919876543210' })).toMatchObject({ senderId: 'invoice', source: 'rule' });
    expect(selectSender(snapshot, { recipient: '+919876543210' })).toMatchObject({ senderId: 'india', source: 'rule' });
  });

  it('falls back to the default sender, or none', () => {
    expect(selectSender(snapshot, { recipient: '+14155550123' })).toMatchObject({ senderId: 'default', source: 'default' });
    expect(selectSender({ senders: [sender('x')], rules: [] }, { recipient: 'a@b.c' })).toBeNull();
  });

  it('returns the pinned provider config of the chosen sender', () => {
    const pinned = { senders: [sender('p', { isDefault: true, providerConfigId: 'cfg-1' })], rules: [] };
    expect(selectSender(pinned, {})).toMatchObject({ providerConfigId: 'cfg-1' });
  });
});
