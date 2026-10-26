/**
 * Provider config validation per kind and channel, and the platform
 * defaults built from the environment.
 */

import 'reflect-metadata';
import configuration from '../../config/configuration.js';
import { NotificationChannel } from '../../constant/index.js';
import { platformProviders } from './platform-providers.js';
import { validateProviderConfig } from './provider.factory.js';

const E = NotificationChannel.Email;
const S = NotificationChannel.Sms;

describe('validateProviderConfig', () => {
  it.each([
    [E, 'smtp', { host: 'smtp.acme.io', port: '587', secure: 'false' }, { user: 'u', pass: 'p' }],
    [E, 'ses', { region: 'eu-west-1' }, {}],
    [E, 'sendgrid', {}, { api_key: 'SG.x' }],
    [S, 'twilio', { messaging_service_sid: 'MG1' }, { account_sid: 'AC1', auth_token: 't' }],
    [S, 'sns', { region: 'us-east-1', sender_id: 'ACME' }, {}],
    [NotificationChannel.Push, 'fcm', {}, { service_account: '{}' }],
  ])('accepts %s/%s', (channel, provider, settings, credentials) => {
    expect(validateProviderConfig(channel, provider, settings, credentials)).toEqual([]);
  });

  it.each([
    [S, 'ses', {}, {}, 'must be one of'],
    [E, 'sendgrid', {}, {}, 'credentials.api_key is required'],
    [E, 'smtp', { host: 'h', port: 'x' }, {}, 'settings.port must be a number'],
    [E, 'smtp', { host: 'h', tls: 'yes' }, {}, 'settings.tls is not supported'],
    [E, 'ses', { region: 'r' }, { access_key_id: 'only-one' }, 'must be set together'],
  ])('rejects %s/%s %#', (channel, provider, settings, credentials, message) => {
    expect(validateProviderConfig(channel, provider, settings, credentials).join(' ')).toContain(message);
  });

  it('checks only given keys for partial updates', () => {
    expect(validateProviderConfig(E, 'sendgrid', {}, {}, true)).toEqual([]);
  });
});

describe('platformProviders', () => {
  it('maps the env configuration to provider specs with factory key names', () => {
    const app = configuration().app;
    app.mail.provider = 'smtp' as never;
    app.mail.smtp = { host: 'mail.local', port: 2525, secure: false, user: 'me', pass: 'pw' };
    const { email } = platformProviders(app);
    expect(email.spec).toMatchObject({ id: 'platform:email', provider: 'smtp', settings: { host: 'mail.local', port: '2525', secure: 'false' } });
    expect(email.credentials).toEqual({ user: 'me', pass: 'pw' });
    expect(validateProviderConfig(E, email.spec.provider, email.spec.settings, email.credentials)).toEqual([]);
  });
});
