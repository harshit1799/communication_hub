/**
 * Email channel: hands rendered emails to the configured provider.
 * The provider is chosen by EMAIL_PROVIDER (console | smtp | ses | sendgrid).
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { DeliveryResult, EmailMessage, EmailProvider } from '../channel/channel.types.js';
import { announceProvider } from '../channel/provider-status.js';

/** DI token of the configured email provider (see the module's factory). */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/** Facade the dispatcher uses for email; hides which vendor is configured. */
@Injectable()
export class EmailService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Email');

  constructor(@Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider) {}

  /** Logs the configured provider and checks it where possible. */
  onModuleInit() {
    announceProvider(this.logger, this.provider);
  }

  /** Name of the configured provider, e.g. for attempt records. */
  get providerName(): string {
    return this.provider.name;
  }

  /** Sends a rendered message. Throws PermanentDeliveryError or a transient error. */
  send(message: EmailMessage): Promise<DeliveryResult> {
    return this.provider.send(message);
  }

  /** Nest lifecycle hook: releases the provider's connections. */
  async onApplicationShutdown() {
    await this.provider.close?.();
  }
}
