// End-to-end test configuration for Vitest (used by `npm run test:e2e`).
import { defineConfig } from 'vitest/config';

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
    // Use a separate database so tests never touch development data.
    // Real environment variables take precedence over these defaults.
    env: {
      DB_NAME: process.env.DB_NAME ?? 'communication_hub_test',
      DB_PASSWORD: process.env.DB_PASSWORD ?? 'postgres',
    },
  },
});
