import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The withTenantTx integration test spins up a real Postgres container
    // (testcontainers) - give it room on a cold `docker pull`.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
