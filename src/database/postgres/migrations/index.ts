/**
 * Every migration, oldest first. Add new migration classes at the end.
 */
import { InitSchema1761000000000 } from './1761000000000-init-schema.js';
import { TemplatesSendersProviders1762000000000 } from './1762000000000-templates-senders-providers.js';
import { InAppInbox1763000000000 } from './1763000000000-in-app-inbox.js';
import { ProviderFromInsteadOfSenders1764000000000 } from './1764000000000-provider-from-instead-of-senders.js';
import { NamedFromAddresses1765000000000 } from './1765000000000-named-from-addresses.js';

/** Loaded by the data source; pending ones run on API startup. */
export const MIGRATIONS = [
  InitSchema1761000000000,
  TemplatesSendersProviders1762000000000,
  InAppInbox1763000000000,
  ProviderFromInsteadOfSenders1764000000000,
  NamedFromAddresses1765000000000,
];
