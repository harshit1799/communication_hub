/**
 * In-process pool of provider clients, one per provider config version.
 *
 * Creating a client is expensive (SMTP pools, Firebase apps, SDK clients),
 * so clients are reused across messages. A config change produces a new
 * version: the next message gets a fresh client and the old one is closed.
 * Clients unused for IDLE_CLOSE_MS (tenant went quiet, config deleted) are
 * closed by a periodic sweep, so memory stays bounded by active configs.
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { errorMessage } from '../../utils/appUtils.js';
import type { ChannelProvider } from '../../utils/channel/channel.types.js';
import { ENCRYPTED } from '../../utils/crypto/encrypted.transformer.js';
import { FieldCipher } from '../../utils/crypto/field-cipher.js';
import { createProviderClient, FactoryContext } from './provider.factory.js';
import type { ProviderSpec } from './provider.types.js';

const IDLE_CLOSE_MS = 15 * 60_000;
const SWEEP_EVERY_MS = 60_000;

interface Entry {
  version: string;
  client: Promise<ChannelProvider>;
  lastUsed: number;
}

@Injectable()
export class ProviderRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger('Providers');
  private readonly entries = new Map<string, Entry>();
  private readonly context: FactoryContext;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly cipher: FieldCipher,
    config: ConfigService,
  ) {
    this.context = { smtpMaxConnections: config.getOrThrow<AppConfig>('app').queue.workers.email.concurrency };
    this.sweeper = setInterval(() => this.closeIdle(), SWEEP_EVERY_MS).unref();
  }

  /**
   * The client for this config version. `plainCredentials` is given for
   * platform defaults (env config); tenant configs carry ciphertext.
   */
  get(spec: ProviderSpec, plainCredentials?: Record<string, string>): Promise<ChannelProvider> {
    const current = this.entries.get(spec.id);
    if (current?.version === spec.version) {
      current.lastUsed = Date.now();
      return current.client;
    }
    if (current) this.close(spec.id, current, 'configuration changed');

    const client = this.create(spec, plainCredentials);
    const entry: Entry = { version: spec.version, client, lastUsed: Date.now() };
    this.entries.set(spec.id, entry);
    // A failed creation must not be cached: the next message retries it.
    client.catch(() => {
      if (this.entries.get(spec.id) === entry) this.entries.delete(spec.id);
    });
    return client;
  }

  private async create(spec: ProviderSpec, plainCredentials?: Record<string, string>): Promise<ChannelProvider> {
    const credentials =
      plainCredentials ??
      (spec.credentials
        ? (JSON.parse(this.cipher.decrypt(spec.credentials, ENCRYPTED.PROVIDER_CREDENTIALS)) as Record<string, string>)
        : {});
    const client = await createProviderClient(spec.channel, spec.provider, spec.settings, credentials, this.context);
    this.logger.log(`Provider ready: ${spec.channel} "${spec.name}" (${client.describe()}) [${spec.id}]`);
    return client;
  }

  /** Closes clients nobody used for a while. */
  private closeIdle() {
    const cutoff = Date.now() - IDLE_CLOSE_MS;
    for (const [id, entry] of this.entries) {
      if (entry.lastUsed < cutoff) this.close(id, entry, 'idle');
    }
  }

  private close(id: string, entry: Entry, reason: string) {
    this.entries.delete(id);
    entry.client
      .then((client) => client.close?.())
      .then(
        () => this.logger.debug(`Closed provider client ${id} (${reason})`),
        (err: unknown) => this.logger.warn(`Closing provider client ${id} failed: ${errorMessage(err)}`),
      );
  }

  /** Closes every client (SMTP pools, Firebase apps) on shutdown. */
  async onApplicationShutdown() {
    clearInterval(this.sweeper);
    const clients = [...this.entries.values()].map((e) => e.client);
    this.entries.clear();
    await Promise.allSettled(clients.map(async (c) => (await c).close?.()));
  }
}
