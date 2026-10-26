/**
 * Secrets Manager loading: which secret is read per APP_ENV, how values
 * land in the environment, and that failures stop startup. Covers
 * fetchSecrets() and the `environment` ConfigModule loader.
 */

// class-transformer (used by validateEnv) needs the metadata polyfill.
import 'reflect-metadata';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validateEnv } from '../config/env.validation.js';
import { fetchSecrets, resolveDeployEnv, SecretsClient } from './secretManager.js';

/** A fake Secrets Manager returning `secret` (or failing with `error`). */
function fakeClient(secret?: unknown, error?: Error) {
  const send = vi.fn((command: GetSecretValueCommand) => {
    void command;
    if (error) return Promise.reject(error);
    return Promise.resolve({ SecretString: typeof secret === 'string' ? secret : JSON.stringify(secret) });
  });
  return { client: { send } as SecretsClient, send };
}

/** Runs `fn` with the given environment variables, restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('fetchSecrets', () => {
  it.each(['development', 'staging', 'preprod', 'production'])(
    'reads communication-hub/%s-env',
    async (appEnv) => {
      const { client, send } = fakeClient({ DB_PASSWORD: 'secret' });
      const secrets = await withEnv({ APP_ENV: appEnv, AWS_SECRET_NAME: undefined }, () => fetchSecrets(client));
      expect(send.mock.calls[0][0].input).toEqual({ SecretId: `communication-hub/${appEnv}-env` });
      expect(secrets).toEqual({ DB_PASSWORD: 'secret' });
    },
  );

  it('honours AWS_SECRET_NAME', async () => {
    const { client, send } = fakeClient({});
    await withEnv({ APP_ENV: 'staging', AWS_SECRET_NAME: 'custom/name' }, () => fetchSecrets(client));
    expect(send.mock.calls[0][0].input).toEqual({ SecretId: 'custom/name' });
  });

  it('stringifies non-string values (e.g. a Firebase service account object)', async () => {
    const { client } = fakeClient({ FIREBASE_SERVICE_ACCOUNT: { project_id: 'p' }, QUEUE_ATTEMPTS: 5 });
    const secrets = await withEnv({ APP_ENV: 'production' }, () => fetchSecrets(client));
    expect(secrets).toEqual({ FIREBASE_SERVICE_ACCOUNT: '{"project_id":"p"}', QUEUE_ATTEMPTS: '5' });
  });

  it('fails with the secret name when AWS errors', async () => {
    const { client } = fakeClient(undefined, new Error('AccessDeniedException'));
    await expect(
      withEnv({ APP_ENV: 'preprod', AWS_SECRET_NAME: undefined }, () => fetchSecrets(client)),
    ).rejects.toThrow(/communication-hub\/preprod-env.*AccessDeniedException/);
  });

  it('rejects secrets that are not a JSON object', async () => {
    const { client } = fakeClient('["not", "an", "object"]');
    await expect(withEnv({ APP_ENV: 'staging' }, () => fetchSecrets(client))).rejects.toThrow('JSON object');
  });

  it('rejects unknown APP_ENV values instead of silently running as local', () => {
    expect(() => resolveDeployEnv({ APP_ENV: 'prod' })).toThrow('APP_ENV must be one of');
  });
});

describe('validateEnv for deployed environments', () => {
  const base = {
    DB_PASSWORD: 'x',
    ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    BLIND_INDEX_KEY: Buffer.alloc(32, 2).toString('base64'),
  };

  it('accepts a minimal local configuration', () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'local' })).not.toThrow();
  });

  it('requires encryption keys in every environment', () => {
    expect(() => validateEnv({ DB_PASSWORD: 'x', APP_ENV: 'local' })).toThrow(/ENCRYPTION_KEYS[\s\S]*BLIND_INDEX_KEY/);
  });

  it('requires ADMIN_API_KEY and real providers outside local', () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'staging' })).toThrow(
      /ADMIN_API_KEY must be set[\s\S]*EMAIL_PROVIDER must be a real provider[\s\S]*SMS_PROVIDER[\s\S]*PUSH_PROVIDER/,
    );
  });

  it('accepts a complete deployed configuration', () => {
    expect(() =>
      validateEnv({
        ...base,
        APP_ENV: 'production',
        ADMIN_API_KEY: 'a'.repeat(32),
        EMAIL_PROVIDER: 'ses',
        AWS_REGION: 'us-east-1',
        SMS_PROVIDER: 'sns',
        PUSH_PROVIDER: 'fcm',
      }),
    ).not.toThrow();
  });
});
