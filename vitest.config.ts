// Unit test configuration for Vitest.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    // Expose describe/it/expect/vi globally (no imports needed in tests).
    globals: true,
    // Project root used to find test files.
    root: './',
    // Unit tests are files ending in .spec.ts.
    include: ['**/*.spec.ts'],
    // Test-only encryption keys (the config loader requires them).
    env: {
      ENCRYPTION_KEYS: 'unit:dW5pdC10ZXN0LWVuY3J5cHRpb24ta2V5LTMyYnl0ZSE=',
      BLIND_INDEX_KEY: 'dW5pdC10ZXN0LWJsaW5kLWluZGV4LWtleS0zMmJ5dGVzIQ==',
    },
  },
});
