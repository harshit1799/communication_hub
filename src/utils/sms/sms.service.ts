/**
 * SMS channel: hands rendered messages to the configured provider.
 * The provider is chosen by SMS_PROVIDER (console | twilio | sns).
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { DeliveryResult, SmsMessage, SmsProvider } from '../channel/channel.types.js';
import { announceProvider } from '../channel/provider-status.js';

/** DI token of the configured SMS provider (see the module's factory). */
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/** Facade the dispatcher uses for SMS; hides which vendor is configured. */
@Injectable()
export class SmsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('SMS');

  constructor(@Inject(SMS_PROVIDER) private readonly provider: SmsProvider) {}

  /** Logs the configured provider and checks it where possible. */
  onModuleInit() {
    announceProvider(this.logger, this.provider);
  }

  /** Name of the configured provider, e.g. for attempt records. */
  get providerName(): string {
    return this.provider.name;
  }

  /** Sends a rendered message. Throws PermanentDeliveryError or a transient error. */
  send(message: SmsMessage): Promise<DeliveryResult> {
    return this.provider.send(message);
  }

  /** Nest lifecycle hook: releases the provider's connections. */
  async onApplicationShutdown() {
    await this.provider.close?.();
  }
}
