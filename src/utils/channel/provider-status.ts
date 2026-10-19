/**
 * Startup log for a channel's delivery provider. Providers with a real
 * connectivity check (SMTP handshake, Firebase token) verify in the
 * background, so a slow or down vendor never delays startup; failures are
 * a warning because sends are retried anyway.
 */

import { Logger } from '@nestjs/common';
import { errorMessage } from '../appUtils.js';
import type { EmailProvider, PushProvider, SmsProvider } from './channel.types.js';

/** Logs which provider a channel uses and, if supported, whether it is reachable. */
export function announceProvider(logger: Logger, provider: EmailProvider | SmsProvider | PushProvider): void {
  const target = provider.describe();
  if (!provider.verify) {
    logger.log(`Provider configured: ${target}`);
    return;
  }
  provider.verify().then(
    () => logger.log(`Connected to ${target}`),
    (err: unknown) => logger.warn(`Cannot reach ${target}: ${errorMessage(err)}. Sends will be retried.`),
  );
}
