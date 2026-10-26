/**
 * Every migration, oldest first. Add new migration classes at the end.
 */
import { InitSchema1761000000000 } from './1761000000000-init-schema.js';
import { TemplatesSendersProviders1762000000000 } from './1762000000000-templates-senders-providers.js';
import { InAppInbox1763000000000 } from './1763000000000-in-app-inbox.js';

/** Loaded by the data source; pending ones run on API startup. */
export const MIGRATIONS = [InitSchema1761000000000, TemplatesSendersProviders1762000000000, InAppInbox1763000000000];
