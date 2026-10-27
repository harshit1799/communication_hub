/**
 * The platform default provider per channel, from the environment
 * (EMAIL_PROVIDER, SMTP_*, SMS_PROVIDER, TWILIO_*, ...). Used for tenants
 * that have no active provider config for a channel, so a new tenant can
 * send immediately and local development needs no database setup.
 */

import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, ProviderChannel, ProviderKind } from '../../constant/index.js';
import { PLATFORM_PROVIDER_ID, ProviderSpec } from './provider.types.js';

/** Settings + plaintext credentials of a platform default, in factory key names. */
export interface PlatformProvider {
  spec: ProviderSpec;
  credentials: Record<string, string>;
}

/** Drops unset values so the factory sees only configured keys. */
const defined = (values: Record<string, string | number | boolean | undefined>) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );

/** Builds the three platform defaults from the typed config. */
export function platformProviders(app: AppConfig): Record<ProviderChannel, PlatformProvider> {
  const awsCredentials = defined({ access_key_id: app.aws.accessKeyId, secret_access_key: app.aws.secretAccessKey });
  const spec = (channel: ProviderChannel, provider: ProviderKind, settings: Record<string, string>): ProviderSpec => ({
    id: `${PLATFORM_PROVIDER_ID}:${channel}`,
    channel,
    provider,
    name: `platform-${provider}`,
    priority: 0,
    settings,
    // The platform default has no named addresses (only MAIL_FROM / vendor default).
    fromAddresses: {},
    // Env-configured: QUEUE_ATTEMPTS / QUEUE_BACKOFF_MS and the channel ceilings apply.
    limits: {},
    credentials: null,
    // Env config only changes with a restart.
    version: 'env',
  });

  const email = app.mail.provider as string as ProviderKind;
  const sms = app.sms.provider as string as ProviderKind;
  const push = app.push.provider as string as ProviderKind;
  return {
    [NotificationChannel.Email]: {
      spec: spec(
        NotificationChannel.Email,
        email,
        email === ProviderKind.Smtp
          ? defined({ host: app.mail.smtp.host, port: app.mail.smtp.port, secure: app.mail.smtp.secure })
          : email === ProviderKind.Ses
            ? { region: app.aws.region }
            : {},
      ),
      credentials:
        email === ProviderKind.Smtp
          ? defined({ user: app.mail.smtp.user, pass: app.mail.smtp.pass })
          : email === ProviderKind.Sendgrid
            ? defined({ api_key: app.mail.sendgridApiKey })
            : awsCredentials,
    },
    [NotificationChannel.Sms]: {
      spec: spec(
        NotificationChannel.Sms,
        sms,
        sms === ProviderKind.Twilio
          ? defined({ from: app.sms.twilio.from, messaging_service_sid: app.sms.twilio.messagingServiceSid })
          : sms === ProviderKind.Sns
            ? defined({ region: app.aws.region, from: app.sms.snsSenderId })
            : {},
      ),
      credentials:
        sms === ProviderKind.Twilio
          ? defined({ account_sid: app.sms.twilio.accountSid, auth_token: app.sms.twilio.authToken })
          : awsCredentials,
    },
    [NotificationChannel.Push]: {
      spec: spec(NotificationChannel.Push, push, {}),
      credentials: defined({ service_account: app.push.firebaseServiceAccount }),
    },
  };
}
