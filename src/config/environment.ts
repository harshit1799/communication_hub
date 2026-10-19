/**
 * Configuration loader, same role as the backend's config/environment.ts:
 * registered in AppModule as `ConfigModule.forRoot({ load: [environment] })`.
 *
 *   APP_ENV = local       .env only (ConfigModule has already loaded it)
 *   APP_ENV = development | staging | preprod | production
 *                         fetch the secret from AWS Secrets Manager and copy
 *                         every key into process.env (secret values win)
 *
 * It then validates the environment (env.validation.ts) and returns the
 * typed configuration, available as `config.get<AppConfig>('app')`.
 *
 * Validation runs here, not in ConfigModule's `validate` option, because
 * that option runs before this async loader, i.e. before the secrets exist.
 *
 * APP_ENV, APP_ROLE and AWS_REGION / AWS_SECRET_NAME select which secret
 * to load and what the process runs, so they must be set on the container,
 * not inside the secret.
 */

import { Logger } from '@nestjs/common';
import { DeployEnv } from '../constant/index.js';
import { fetchSecrets, resolveDeployEnv } from '../utils/secretManager.js';
import configuration, { AppConfig } from './configuration.js';
import { validateEnv } from './env.validation.js';

const logger = new Logger('Environment');

/** Loads secrets (outside local), validates and returns the typed config. */
export const environment = async (): Promise<{ app: AppConfig }> => {
  const deployEnv = resolveDeployEnv();
  if (deployEnv !== DeployEnv.Local) {
    const secrets = await fetchSecrets();
    for (const envKey of Object.keys(secrets)) {
      process.env[envKey] = secrets[envKey];
    }
    // Names only, never values.
    logger.log(`Loaded ${Object.keys(secrets).length} variables from AWS Secrets Manager (APP_ENV=${deployEnv})`);
  } else {
    logger.log('APP_ENV=local: using .env and process environment');
  }
  // Fail startup with a readable list if anything is missing or invalid.
  validateEnv(process.env);
  return configuration();
};
