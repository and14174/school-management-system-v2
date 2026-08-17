import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The RLS/merge/duplicate-detection integration suite spins up a real
    // Postgres container (testcontainers) and applies the real audit +
    // tenancy + identity + this module's own migrations to it - give it room
    // on a cold `docker pull`.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
