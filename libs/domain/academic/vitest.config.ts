import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The RLS/effective-dating/section-scope integration suite spins up a
    // real Postgres container (testcontainers) and applies the real audit +
    // tenancy + identity + access + custom-fields + people + this module's
    // own migrations to it - give it room on a cold `docker pull`.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
