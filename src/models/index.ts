/**
 * Registry of all TypeORM entities (one file per table).
 * ENTITIES is what the data source loads; add every new model to it.
 */

import { ApiKey } from './api-key.model.js';
import { DeviceToken } from './device-token.model.js';
import { InboxMessage } from './inbox-message.model.js';
import { NotificationAttempt } from './notification-attempt.model.js';
import { Notification } from './notification.model.js';
import { ProviderConfig } from './provider-config.model.js';
import { SenderIdentity } from './sender-identity.model.js';
import { SenderRule } from './sender-rule.model.js';
import { TemplateVersion } from './template-version.model.js';
import { Template } from './template.model.js';
import { Tenant } from './tenant.model.js';

export * from './api-key.model.js';
export * from './device-token.model.js';
export * from './inbox-message.model.js';
export * from './notification-attempt.model.js';
export * from './notification.model.js';
export * from './provider-config.model.js';
export * from './sender-identity.model.js';
export * from './sender-rule.model.js';
export * from './template-version.model.js';
export * from './template.model.js';
export * from './tenant.model.js';

/** Every entity, registered on the data source. Add new models here. */
export const ENTITIES = [
  Tenant,
  ApiKey,
  Notification,
  NotificationAttempt,
  DeviceToken,
  Template,
  TemplateVersion,
  SenderIdentity,
  SenderRule,
  ProviderConfig,
  InboxMessage,
];
