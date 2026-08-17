#!/usr/bin/env tsx
/**
 * Applies every `*.sql` file under `migrations/` in lexical filename order,
 * as the `sms_owner` role (`DATABASE_MIGRATION_URL`). Idempotent: each
 * applied filename is recorded in `platform.__migrations`, so re-running
 * this is a no-op once everything is up to date.
 *
 * Usage: tsx src/migrate.ts   (or `pnpm db:migrate` from apps/api / root)
 */
import { globSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local convenience only - see drizzle.config.ts for the same pattern.
// Resolved relative to this file (not process.cwd()), since this script is
// invoked from several different working directories (root, apps/api,
// this package directly) via various package.json scripts.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const databaseMigrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!databaseMigrationUrl) {
  console.error(
    'DATABASE_MIGRATION_URL is not set. Copy .env.example to .env, or export it in your shell before running the migrator.',
  );
  process.exit(1);
}

const repoRoot = join(__dirname, '..', '..', '..', '..');

/**
 * Every module owns its own `migrations/` folder - the schema lives with the
 * code that owns it, and two modules being built in parallel never collide in
 * a shared directory.
 *
 * Global ordering comes from a numeric filename prefix, with a reserved range
 * per module so the numbers can never clash:
 *
 *   0000-0099  shared/db      bootstrap (platform schema, migration ledger)
 *   0100-0199  platform/audit must be first: later modules attach its trigger
 *   0200-0299  platform/tenancy
 *   0300-0399  platform/identity
 *   0400-0449  platform/access
 *   0450-0499  platform/custom-fields
 *   0500-0599  domain/people
 *   0600-0699  domain/academic
 *   0700-0799  domain/enrollment
 *   0800-0849  platform/import-export
 *   0850-0899  platform/outbox
 *   0900-0999  domain/attendance
 *   1000-1099  domain/gradebook
 *   1100-1149  platform/documents
 *   1200-1299  domain/records
 *   1300-1349  platform/notifications
 *   1350-1399  domain/communications
 *   1400-1499  domain/billing
 *   1500-1599  domain/admissions
 *   1600-1699  platform/public-api
 *   1700-1799  platform/approvals
 *
 * Keep this list current when a module claims a range. It drifted once already
 * (it read "0500+ allocated as they are built" while thirteen modules had
 * quietly claimed ranges), and a stale map is exactly how two modules built in
 * parallel pick the same prefix - which the duplicate-filename check below
 * catches only after both are written.
 *
 * Filenames must therefore be globally unique, which is also what the
 * `platform.__migrations` ledger keys on.
 */
function discoverMigrations(): Array<{ id: string; path: string; source: string }> {
  const files = globSync('{libs,apps}/**/migrations/*.sql', {
    cwd: repoRoot,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  });

  const seen = new Map<string, string>();
  for (const rel of files) {
    const id = basename(rel);
    const previous = seen.get(id);
    if (previous) {
      throw new Error(
        `Duplicate migration filename "${id}" in both ${previous} and ${rel}. ` +
          `Migration filenames must be globally unique - check the reserved prefix range for your module.`,
      );
    }
    seen.set(id, rel);
  }

  // `rel` is already relative to repoRoot (globSync was given cwd: repoRoot),
  // so it is the display path as-is.
  return [...seen.entries()]
    .map(([id, rel]) => ({ id, path: join(repoRoot, rel), source: rel.replaceAll('\\', '/') }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

async function main(): Promise<void> {
  const sql = postgres(databaseMigrationUrl!, { max: 1, onnotice: () => {} });

  try {
    await sql`create schema if not exists platform`;
    await sql`
      create table if not exists platform.__migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const files = discoverMigrations();

    if (files.length === 0) {
      console.log('no migrations found');
      return;
    }

    let appliedCount = 0;

    for (const file of files) {
      const alreadyApplied = await sql`
        select 1 from platform.__migrations where id = ${file.id}
      `;

      if (alreadyApplied.length > 0) {
        console.log(`  skip   ${file.id} (already applied)`);
        continue;
      }

      const sqlText = readFileSync(file.path, 'utf8');
      console.log(`  apply  ${file.id}  (${file.source})`);

      await sql.begin(async (trx) => {
        await trx.unsafe(sqlText);
        await trx`insert into platform.__migrations (id) values (${file.id})`;
      });

      appliedCount += 1;
    }

    console.log(
      appliedCount > 0
        ? `migrations complete - ${appliedCount} applied, ${files.length - appliedCount} already up to date`
        : `migrations up to date - nothing to apply (${files.length} already applied)`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exit(1);
});
