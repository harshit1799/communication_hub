// End-to-end test configuration for Vitest (used by `npm run test:e2e`).
import { defineConfig } from 'vitest/config';

// Reuse connection settings (DB_PASSWORD, REDIS_HOST, ...) from .env.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables.
}

export default defineConfig({
  // Resolve tsconfig.json path aliases.
  resolve: { tsconfigPaths: true },
  test: {
    // Expose describe/it/expect/vi globally.
    globals: true,
    // Project root used to find test files.
    root: './',
    // E2E tests are files ending in .e2e-spec.ts.
    include: ['**/*.e2e-spec.ts'],
    // The app boots once per file (gRPC server + workers); give migrations and Redis time.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Each file boots the app with live workers on the same Redis/DB;
    // run files one after another so they don't consume each other's jobs.
    fileParallelism: false,
    // Always a separate database and Redis namespace, so tests never touch
    // development data, whatever .env says.
    env: {
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      DB_NAME: process.env.TEST_DB_NAME ?? 'communication_hub_test',
      DB_PASSWORD: process.env.DB_PASSWORD ?? 'postgres',
      REDIS_KEY_PREFIX: 'chub-e2e',
      ADMIN_API_KEY: 'e2e-admin-key-0123456789abcdef0123456789',
      EMAIL_PROVIDER: 'console',
      SMS_PROVIDER: 'console',
      PUSH_PROVIDER: 'console',
      QUEUE_BACKOFF_MS: '100',
      THROTTLE_LIMIT: '10000',
      LOG_LEVEL: 'silent',
      // Fixed test-only keys (never use these anywhere else).
      ENCRYPTION_KEYS: 'e2e:ZTJlLXRlc3QtZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=',
      ENCRYPTION_ACTIVE_KEY: 'e2e',
      BLIND_INDEX_KEY: 'ZTJlLXRlc3QtYmxpbmQtaW5kZXgta2V5LTMyLWJ5dGVzIQ==',
      // Each test file picks a free gRPC port; no ops HTTP server in tests.
      OPS_PORT: '0',
      // The gateway e2e test starts its own gateway against the test server.
      HTTP_PORT: '0',
      GRPC_REFLECTION: 'false',
      // Short caches so tests that bypass the API see changes quickly.
      PROVIDER_CACHE_TTL_SECONDS: '5',
    },
  },
});
