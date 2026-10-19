/**
 * The `environment` ConfigModule loader: no AWS call for APP_ENV=local,
 * and in deployed environments the secret's values override .env and end
 * up in the typed config. fetchSecrets is stubbed (no AWS needed).
 */

// class-transformer (used by validateEnv) needs the metadata polyfill.
import 'reflect-metadata';
import { fetchSecrets } from '../utils/secretManager.js';
import { environment } from './environment.js';

vi.mock('../utils/secretManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/secretManager.js')>()),
  fetchSecrets: vi.fn(),
}));

/** Runs `fn` with the given environment variables, restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const fetchSecretsMock = vi.mocked(fetchSecrets);

describe('environment', () => {
  // Block body: a function returned from beforeEach is run as a teardown.
  beforeEach(() => {
    fetchSecretsMock.mockReset();
  });

  it('APP_ENV=local: no AWS call, config from .env / process environment', async () => {
    const config = await withEnv({ APP_ENV: 'local', DB_PASSWORD: 'from-dotenv' }, () => environment());
    expect(fetchSecretsMock).not.toHaveBeenCalled();
    expect(config.app.database.password).toBe('from-dotenv');
    expect(config.app.deployEnv).toBe('local');
  });

  it('deployed env: secret values override .env and end up in the config', async () => {
    fetchSecretsMock.mockResolvedValue({
      DB_PASSWORD: 'from-secret',
      ADMIN_API_KEY: 'k'.repeat(32),
      EMAIL_PROVIDER: 'ses',
      SMS_PROVIDER: 'sns',
      PUSH_PROVIDER: 'fcm',
      // SES and SNS need a region (validated).
      AWS_REGION: 'us-east-1',
    });
    const config = await withEnv(
      { APP_ENV: 'staging', DB_PASSWORD: 'from-dotenv', ADMIN_API_KEY: undefined, EMAIL_PROVIDER: undefined, SMS_PROVIDER: undefined, PUSH_PROVIDER: undefined },
      () => environment(),
    );
    expect(fetchSecretsMock).toHaveBeenCalledTimes(1);
    expect(config.app).toMatchObject({ deployEnv: 'staging', database: { password: 'from-secret' }, mail: { provider: 'ses' } });
  });

  it('stops startup when the secret cannot be loaded', async () => {
    fetchSecretsMock.mockRejectedValue(new Error('Could not load AWS Secrets Manager secret "communication-hub/preprod-env"'));
    await expect(withEnv({ APP_ENV: 'preprod' }, () => environment())).rejects.toThrow('communication-hub/preprod-env');
  });

  it('stops startup when the loaded configuration is invalid', async () => {
    fetchSecretsMock.mockResolvedValue({ DB_PASSWORD: 'x' });
    await expect(
      withEnv({ APP_ENV: 'production', ADMIN_API_KEY: undefined, EMAIL_PROVIDER: undefined }, () => environment()),
    ).rejects.toThrow(/ADMIN_API_KEY must be set/);
  });
});
