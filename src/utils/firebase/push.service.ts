/**
 * Push channel: hands rendered push messages to the configured provider.
 * The provider is chosen by PUSH_PROVIDER (console | fcm).
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { DeliveryResult, PushMessage, PushProvider } from '../channel/channel.types.js';
import { announceProvider } from '../channel/provider-status.js';

/** DI token of the configured push provider (see the module's factory). */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** Facade the dispatcher uses for push; hides which vendor is configured. */
@Injectable()
export class PushService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Push');

  constructor(@Inject(PUSH_PROVIDER) private readonly provider: PushProvider) {}

  /** Logs the configured provider and checks it where possible. */
  onModuleInit() {
    announceProvider(this.logger, this.provider);
  }

  /** Name of the configured provider, e.g. for attempt records. */
  get providerName(): string {
    return this.provider.name;
  }

  /** Sends a rendered message. Throws PermanentDeliveryError or a transient error. */
  send(message: PushMessage): Promise<DeliveryResult> {
    return this.provider.send(message);
  }

  /** Nest lifecycle hook: releases the provider's connections. */
  async onApplicationShutdown() {
    await this.provider.close?.();
  }
}
