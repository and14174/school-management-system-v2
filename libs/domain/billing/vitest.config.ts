import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Same testcontainers posture as @sms/records's vitest.config.ts: this
    // suite spins up a real Postgres container and applies the real
    // audit + tenancy + identity + access + people + outbox + this module's
    // own migrations to it.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
