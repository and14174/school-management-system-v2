import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // audit.spec.ts spins up a real Postgres container (testcontainers) and
    // applies the full 0100_audit.sql migration against it - give it room
    // on a cold `docker pull`, same as libs/shared/db's tx.spec.ts.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
