/**
 * Fetches the service's configuration from AWS Secrets Manager. Same shape
 * as the backend's utils/secretManager.ts: one fetchSecrets() that reads
 * AWS_SECRET_MANAGER.SECRET_NAME in AWS_SECRET_MANAGER.REGION and returns
 * the parsed JSON. Called by config/environment.ts.
 *
 * Credentials come from the default AWS chain (IRSA / instance role in the
 * cluster, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or ~/.aws locally).
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AWS_SECRET_MANAGER, DeployEnv } from '../constant/index.js';

/** Minimal client surface used here, so tests can pass a fake. */
export interface SecretsClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** Reads APP_ENV, rejecting unknown values instead of silently using local. */
export function resolveDeployEnv(env: NodeJS.ProcessEnv = process.env): DeployEnv {
  const value = (env.APP_ENV || DeployEnv.Local) as DeployEnv;
  if (!Object.values(DeployEnv).includes(value)) {
    throw new Error(`APP_ENV must be one of ${Object.values(DeployEnv).join(', ')} (got "${value}")`);
  }
  return value;
}

/**
 * Returns the secret as a map of environment variables. Nested values (e.g.
 * a Firebase service account stored as an object) become JSON strings.
 * Throws an error naming the secret if it can't be read or isn't an object.
 */
export const fetchSecrets = async (
  client: SecretsClient = new SecretsManagerClient({ region: AWS_SECRET_MANAGER.REGION, maxAttempts: 3 }),
): Promise<Record<string, string>> => {
  const secretId = AWS_SECRET_MANAGER.SECRET_NAME;
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) throw new Error('the secret has no string value');
    const parsed: unknown = JSON.parse(response.SecretString);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the secret must be a JSON object of environment variables');
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
    );
  } catch (error) {
    throw new Error(
      `Could not load AWS Secrets Manager secret "${secretId}" (${AWS_SECRET_MANAGER.REGION}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};
