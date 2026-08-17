import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The RLS integration suite spins up a real Postgres container
    // (testcontainers) and applies the real audit + tenancy + this module's
    // own migrations to it, then drives real Chromium/Playwright renders and
    // a real MinIO upload - give it room on a cold `docker pull` / browser
    // launch.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
