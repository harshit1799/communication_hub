/**
 * Push through Firebase Cloud Messaging (Android, iOS via APNs, web).
 *
 * Sends to many devices in batches of 500 (FCM limit) and reports tokens FCM
 * says are dead, so they can be deactivated and never retried.
 *
 * Note: firebase-admin 14 deprecates registration `tokens` in favour of
 * Firebase Installation IDs (`fids`). Tokens still work; migrate once the
 * mobile apps register FIDs.
 */

import { App, applicationDefault, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../constant/index.js';
import {
  DeliveryResult,
  PermanentDeliveryError,
  PushMessage,
  PushProvider,
} from '../channel/channel.types.js';

// The device is gone or the token is malformed: never retry, deactivate.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
// The request itself is invalid; retrying won't help.
const PERMANENT_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-payload',
  'messaging/payload-size-limit-exceeded',
  'messaging/mismatched-credential',
]);

/** Accepts the service account as raw JSON, base64 JSON or a file path. */
function parseServiceAccount(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  if (decoded.trim().startsWith('{')) return JSON.parse(decoded);
  return JSON.parse(readFileSync(trimmed, 'utf8'));
}

/** FCM provider. Each instance owns a uniquely named firebase-admin app. */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly app: App;
  private readonly messaging: Messaging;
  private readonly projectId?: string;

  constructor(serviceAccount?: string) {
    const account = serviceAccount ? parseServiceAccount(serviceAccount) : undefined;
    this.projectId = account?.project_id;
    this.app = initializeApp(
      {
        // No service account = Application Default Credentials (GCP / GOOGLE_APPLICATION_CREDENTIALS).
        credential: account ? cert(account) : applicationDefault(),
      },
      // Named app: never clashes with another firebase-admin user in-process.
      `communication-hub-${randomUUID()}`,
    );
    this.messaging = getMessaging(this.app);
  }

  /**
   * Sends to every token in batches of 500. Succeeds if at least one
   * device was reached; dead tokens are returned for deactivation.
   */
  async send(message: PushMessage): Promise<DeliveryResult> {
    let delivered = 0;
    let firstMessageId: string | undefined;
    const deadTokens: string[] = [];
    const permanent: string[] = [];
    const transient: string[] = [];

    for (let i = 0; i < message.tokens.length; i += LIMITS.FCM_MULTICAST_MAX) {
      const tokens = message.tokens.slice(i, i + LIMITS.FCM_MULTICAST_MAX);
      const batch = await this.messaging.sendEachForMulticast(
        message.silent
          ? {
              // Data-only: delivered to the app, nothing shown. iOS needs a
              // background push (content-available, priority 5).
              tokens,
              data: message.data,
              android: { priority: 'high' },
              apns: { headers: { 'apns-push-type': 'background', 'apns-priority': '5' }, payload: { aps: { contentAvailable: true } } },
            }
          : {
              tokens,
              notification: { title: message.title, body: message.body },
              data: message.data,
              android: { priority: 'high' },
              apns: { payload: { aps: { sound: 'default' } } },
            },
      );
      batch.responses.forEach((response, index) => {
        if (response.success) {
          delivered++;
          firstMessageId ??= response.messageId;
          return;
        }
        const code = response.error?.code ?? 'unknown';
        const detail = `${code}: ${response.error?.message ?? ''}`;
        if (DEAD_TOKEN_CODES.has(code)) deadTokens.push(tokens[index]);
        else if (PERMANENT_CODES.has(code)) permanent.push(detail);
        else transient.push(detail);
      });
    }

    // Reached at least one device: success. Devices that failed transiently
    // are not retried, since a retry would duplicate the push on the others.
    if (delivered > 0) {
      return {
        provider: this.name,
        providerMessageId: `${firstMessageId} (${delivered}/${message.tokens.length})`,
        invalidTokens: deadTokens,
      };
    }
    if (transient.length > 0) {
      throw new Error(`FCM delivery failed: ${transient[0]}`);
    }
    throw new PermanentDeliveryError(
      permanent[0] ?? 'All device tokens are invalid or unregistered',
      this.name,
      deadTokens,
    );
  }

  /** Log label (no secrets). */
  describe(): string {
    return `Firebase Cloud Messaging (project ${this.projectId ?? 'from default credentials'})`;
  }

  /** Fetches a Google access token: proves the credentials are valid. */
  async verify(): Promise<void> {
    await this.app.options.credential!.getAccessToken();
  }

  /** Deletes the firebase-admin app (closes its HTTP connections). */
  async close(): Promise<void> {
    await deleteApp(this.app);
  }
}
