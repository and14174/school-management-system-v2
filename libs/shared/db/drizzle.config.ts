import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local convenience only: when this is invoked directly (drizzle-kit generate /
// studio) there is no NestJS ConfigModule around to load .env for us. In CI/
// production the real environment variables are already set, so a missing
// .env file here is not an error. Resolved relative to this file (not
// process.cwd()), since apps/api's db:generate/db:studio scripts invoke this
// config from apps/api's working directory, not this package's.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const databaseMigrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!databaseMigrationUrl) {
  throw new Error(
    'DATABASE_MIGRATION_URL is not set. Copy .env.example to .env, or export it in your shell before running drizzle-kit.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  // Every module's Drizzle schema lives in a schema.ts next to its migrations,
  // wherever it sits under libs/ (platform/<module>, domain/<module>, ...).
  schema: '../../../libs/**/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: databaseMigrationUrl,
  },
});
