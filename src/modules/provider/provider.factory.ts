/**
 * Builds provider clients from configuration, and validates configuration
 * before it is stored. One place knows what every provider kind needs:
 *
 *   kind       settings                         credentials
 *   smtp       host*, port, secure, from        user, pass
 *   ses        region*, from                    access_key_id, secret_access_key
 *   sendgrid   from                             api_key*
 *   twilio     from, messaging_service_sid      account_sid*, auth_token*
 *   sns        region*, from (sender id)        access_key_id, secret_access_key
 *   fcm        -                                service_account*
 *   console    from                             -
 *
 * `from` is the "From" the provider sends as (format checked per channel);
 * NotificationInput.from overrides it per message.
 *   (* required)
 *
 * Vendor SDKs are imported only when a config of that kind is first used.
 */

import { CHANNEL_PROVIDERS, NotificationChannel, ProviderChannel, ProviderKind } from '../../constant/index.js';
import type { ChannelProvider } from '../../utils/channel/channel.types.js';
import { isFromValue } from '../../validator/from.validator.js';
import { ConsoleProvider } from '../../utils/channel/console.provider.js';

/** Required / allowed keys per provider kind. */
interface KindRules {
  settings: { required: string[]; optional: string[] };
  credentials: { required: string[]; optional: string[] };
}

const RULES: Record<ProviderKind, KindRules> = {
  [ProviderKind.Console]: { settings: { required: [], optional: ['from'] }, credentials: { required: [], optional: [] } },
  [ProviderKind.Smtp]: {
    settings: { required: ['host'], optional: ['port', 'secure', 'from'] },
    credentials: { required: [], optional: ['user', 'pass'] },
  },
  [ProviderKind.Ses]: {
    settings: { required: ['region'], optional: ['from'] },
    credentials: { required: [], optional: ['access_key_id', 'secret_access_key'] },
  },
  [ProviderKind.Sendgrid]: { settings: { required: [], optional: ['from'] }, credentials: { required: ['api_key'], optional: [] } },
  [ProviderKind.Twilio]: {
    settings: { required: [], optional: ['from', 'messaging_service_sid'] },
    credentials: { required: ['account_sid', 'auth_token'], optional: [] },
  },
  [ProviderKind.Sns]: {
    settings: { required: ['region'], optional: ['from'] },
    credentials: { required: [], optional: ['access_key_id', 'secret_access_key'] },
  },
  [ProviderKind.Fcm]: { settings: { required: [], optional: [] }, credentials: { required: ['service_account'], optional: [] } },
};

/**
 * Problems with a provider config, one message each (empty = valid).
 * `partial` checks an update: only the keys given are validated.
 */
export function validateProviderConfig(
  channel: NotificationChannel,
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
  partial = false,
): string[] {
  const kind = provider as ProviderKind;
  if (channel === NotificationChannel.InApp) {
    return ['in-app notifications use the tenant\'s push providers: configure CHANNEL_PUSH instead'];
  }
  if (!CHANNEL_PROVIDERS[channel].includes(kind)) {
    return [`provider must be one of ${CHANNEL_PROVIDERS[channel].join(', ')} for channel ${channel}`];
  }
  const rules = RULES[kind];
  const errors: string[] = [];
  const check = (what: 'settings' | 'credentials', values: Record<string, string>) => {
    const { required, optional } = rules[what];
    for (const key of Object.keys(values)) {
      if (![...required, ...optional].includes(key)) errors.push(`${what}.${key} is not supported by ${kind}`);
    }
    if (!partial) for (const key of required) if (!values[key]) errors.push(`${what}.${key} is required for ${kind}`);
  };
  check('settings', settings);
  check('credentials', credentials);
  if (settings.from !== undefined && !isFromValue(channel, settings.from)) {
    errors.push(
      channel === NotificationChannel.Email
        ? 'settings.from must be an email address, optionally "Name <address>"'
        : 'settings.from must be an E.164 number, a short code or a 3-11 character alphanumeric sender id',
    );
  }
  if (settings.port !== undefined && !/^\d{1,5}$/.test(settings.port)) errors.push('settings.port must be a number');
  if (settings.secure !== undefined && !['true', 'false'].includes(settings.secure)) errors.push('settings.secure must be true or false');
  const aws = ['access_key_id', 'secret_access_key'].filter((k) => credentials[k]);
  if (!partial && aws.length === 1) errors.push('credentials.access_key_id and secret_access_key must be set together');
  return errors;
}

/** Process-level inputs a client needs besides its own config. */
export interface FactoryContext {
  // SMTP pool size (follows the email worker concurrency).
  smtpMaxConnections: number;
}

/** Creates a client for one provider config (settings + decrypted credentials). */
export async function createProviderClient(
  channel: ProviderChannel,
  provider: ProviderKind,
  settings: Record<string, string>,
  credentials: Record<string, string>,
  context: FactoryContext,
): Promise<ChannelProvider> {
  const aws = () => ({
    region: settings.region,
    accessKeyId: credentials.access_key_id,
    secretAccessKey: credentials.secret_access_key,
  });
  switch (provider) {
    case ProviderKind.Smtp: {
      const { SmtpEmailProvider } = await import('../../utils/email/providers/smtp.provider.js');
      return new SmtpEmailProvider(
        {
          host: settings.host,
          port: Number(settings.port ?? 587),
          secure: settings.secure === 'true',
          user: credentials.user,
          pass: credentials.pass,
        },
        context.smtpMaxConnections,
      );
    }
    case ProviderKind.Ses: {
      const { SesEmailProvider } = await import('../../utils/email/providers/ses.provider.js');
      return new SesEmailProvider(aws());
    }
    case ProviderKind.Sendgrid: {
      const { SendgridEmailProvider } = await import('../../utils/email/providers/sendgrid.provider.js');
      return new SendgridEmailProvider(credentials.api_key);
    }
    case ProviderKind.Twilio: {
      const { TwilioSmsProvider } = await import('../../utils/sms/providers/twilio.provider.js');
      return new TwilioSmsProvider({
        accountSid: credentials.account_sid,
        authToken: credentials.auth_token,
        from: settings.from,
        messagingServiceSid: settings.messaging_service_sid,
      });
    }
    case ProviderKind.Sns: {
      const { SnsSmsProvider } = await import('../../utils/sms/providers/sns.provider.js');
      return new SnsSmsProvider(aws(), settings.from);
    }
    case ProviderKind.Fcm: {
      const { FcmPushProvider } = await import('../../utils/firebase/fcm.provider.js');
      return new FcmPushProvider(credentials.service_account);
    }
    default:
      return new ConsoleProvider(channel);
  }
}
