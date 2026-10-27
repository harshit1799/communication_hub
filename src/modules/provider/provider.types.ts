/**
 * Shapes used on the send path for provider configuration.
 */

import { ProviderChannel, ProviderKind } from '../../constant/index.js';
import type { ChannelProvider } from '../../utils/channel/channel.types.js';

/**
 * A provider config as cached in Redis. Credentials stay encrypted in the
 * cache; they are decrypted in-process only when a client is created.
 */
export interface ProviderSpec {
  // provider_configs.id, or "platform:<channel>" for the env default.
  id: string;
  channel: ProviderChannel;
  provider: ProviderKind;
  name: string;
  priority: number;
  settings: Record<string, string>;
  // Named From addresses (name -> address).
  fromAddresses: Record<string, string>;
  // Ciphertext (FieldCipher); null for the platform default (env config).
  credentials: string | null;
  // Changes whenever the config changes: a new version gets a new client.
  version: string;
}

/**
 * One provider to try, in failover order. The client is created on first
 * use, so a config whose client can't be built (bad credentials format)
 * fails over to the next provider instead of blocking all of them.
 */
export interface ProviderHandle {
  spec: ProviderSpec;
  client(): Promise<ChannelProvider>;
}

/** Id prefix of the platform default (env-configured) providers. */
export const PLATFORM_PROVIDER_ID = 'platform';
